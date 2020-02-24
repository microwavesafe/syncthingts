/*
This file is part of Syncthing TS.

Syncthing TS is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Syncthing TS is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Syncthing TS.  If not, see <https://www.gnu.org/licenses/>.
*/

import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { EventEmitter } from 'events';
import Long from 'long';

import { load, Root, util } from 'protobufjs';
import { decompressBlock } from 'lz4js';

import { CLIENT_NAME, VERSION, Cluster, Folder, File, Device, Index, SyncStatus, Directory, Block, Response } from './constants';
import { BlockRequest } from './request';
import Authentication, { DeviceId } from './authentication';
import PeerSocket from './peerSocket';

// TODO: retry on error / disconnection

export enum ProtocolMessage {
    CLUSTER_CONFIG = 0,
    INDEX,
    INDEX_UPDATE,
    REQUEST,
    RESPONSE,
    DOWNLOAD_PROGRESS,
    PING,
    CLOSE,
}

enum MessageState {
    start = 0,
    continue = 1,
}

export interface Message {
    type: number;
    compression: number;
    headerLength: number;
    length: number;
    decompressedLength: number;
    received: number;
    data: Uint8Array;
    state: MessageState;
}

export default class Communication {
    private socket: PeerSocket;
    private protocol: Root;
    private event = new EventEmitter();
    private pingTimer: any;

    private deviceName: string;
    private message: Message;
    private extraDebugging: boolean;

    localId: DeviceId;
    remoteId: DeviceId;

    private TYPE_TO_MESSAGE = [
        'ClusterConfig',
        'Index',
        'IndexUpdate',
        'Request',
        'Response',
        'DownloadProgress',
        'Ping',
        'Close'
    ];

    private async loadProtocol() {
        try {
            this.protocol = await load(join(__dirname, 'bep.proto'));
        }
        catch (err) {
            throw err;
        }
    }

    private encodeMessage(type: string, messageObject: object) : Uint8Array {
        const messageProto = this.protocol.lookupType('protocol.' + type);

        if (type === 'ClusterConfig') {
            const cluster = <Cluster>messageObject;

            const encodedCluster = {
                folders: []
            };

            for (const folder of cluster.folders) {
                const encodedFolder = {
                    id: folder.idString,
                    label: folder.label,
                    ignorePermissions: true,
                    devices: [],
                };

                for (const device of folder.devices) {
                    encodedFolder.devices.push({
                        id: device.id,
                        name: device.name,
                        addresses: device.addresses.split(','),
                        maxSequence: Long.fromNumber(device.maxSequence),
                        // @ts-ignore, although it doesn't have push or pop it is still an array
                        indexId: Long.fromBytesBE(device.indexId),
                    });
                }

                encodedCluster.folders.push(encodedFolder);
            }

            messageObject = encodedCluster;
        }

        const messageBuffer = messageProto.fromObject(messageObject);
        const encodedMessage = messageProto.encode(messageBuffer).finish();

        return encodedMessage;
    }

    private combineFlags(item: any) {
        const deleted = item.deleted ? 1 : 0;
        const invalid = item.invalid ? 1 : 0;
        const noPermissions = item.noPermissions ? 1 : 0;
        return (deleted | (invalid << 1) | (noPermissions << 2));
    }

    // Force message into internal representation, simplifies data transfer between classes
    private decodeMessage(type: string, messageData: Uint8Array) : Object {
        const messageProto = this.protocol.lookupType('protocol.' + type);

        try {
            const decodedMessage = messageProto.decode(messageData);

            if (type === 'ClusterConfig') {
                const cluster: Cluster = {
                    folders: [],
                };

                for (const decodedFolder of decodedMessage['folders']) {
                    if (this.extraDebugging) {
                        console.debug('Communication::decodeMessage:', decodedFolder);
                    }

                    const folder: Folder = {
                        idString: decodedFolder.id,
                        label: decodedFolder.label,
                        path: '',
                        flags: 0,
                        devices: []
                    };

                    for (const decodedDevice of decodedFolder.devices) {
                        const device: Device = {
                            folderIdString: folder.idString,
                            id: new Uint8Array(decodedDevice.id),
                            name: decodedDevice.name,
                            addresses: decodedDevice.addresses.join(),
                            indexId: new Uint8Array(decodedDevice.indexId.toBytesBE()),
                            // TODO: throw error on number larger than 2^53
                            maxSequence: decodedDevice.maxSequence ? decodedDevice.maxSequence.toNumber() : 0,
                        };
                        folder.devices.push(device);
                    }

                    cluster.folders.push(folder);
                }

                return cluster;
            }

            else if (type === 'Index' || type === 'IndexUpdate') {
                const index : Index = {
                    folder: decodedMessage['folder'],
                    directories: []
                };

                for (const decodedFile of decodedMessage['files']) {
                    decodedFile.name = '/' + decodedFile.name;

                    const common = {
                        permissions: decodedFile.permissions,
                        modifiedS: decodedFile.modifiedS ? decodedFile.modifiedS.toNumber() : 0,
                        modifiedNs: decodedFile.modifiedNs,
                        modifiedBy: new Uint8Array(decodedFile.modifiedBy.toBytesBE()),
                        flags: this.combineFlags(decodedFile),
                        sequence: decodedFile.sequence ? decodedFile.sequence.toNumber() : 0,
                        version: JSON.stringify(decodedFile.version),
                        sync: SyncStatus.none,
                    };

                    // if directory
                    if (decodedFile.type === 1) {

                        const directory : Directory = {
                            ...common,
                            name: decodedFile.name,
                            files: []
                        };

                        // directory could have been created by file
                        let assigned = false;
                        for (let i=0; i<index.directories.length; i++) {
                            if (index.directories[i].name === directory.name) {
                                index.directories[i] = directory;
                                assigned = true;
                                break;
                            }
                        }

                        if (!assigned) {
                            index.directories.push(directory);
                        }
                    }
                    // else symlink (4) or file (0)
                    else {
                        const file : File = {
                            ...common,
                            name: basename(decodedFile.name),
                            size: decodedFile.size.toNumber(),
                            symlinkTarget: decodedFile.symlinkTarget ? decodedFile.symlinkTarget : '',
                            blockSize: decodedFile.blockSize ? decodedFile.blockSize : 0,
                            blocks: [],
                        };

                        for (const decodedBlock of decodedFile.blocks) {
                            file.blocks.push({
                                offset: decodedBlock.offset ? decodedBlock.offset.toNumber() : 0,
                                size: decodedBlock.size ? decodedBlock.size : 0,
                                hash: new Uint8Array(decodedBlock.hash),
                                cached: 0
                            });
                        }

                        let directoryCreated = false;
                        for (let i=0; i<index.directories.length; i++) {
                            if (index.directories[i].name === dirname(decodedFile.name)) {
                                index.directories[i].files.push(file);
                                directoryCreated = true;
                                break;
                            }
                        }

                        if (!directoryCreated) {
                            // create place holder, set so rest of code knows its place holder and not update
                            index.directories.push({
                                name: dirname(decodedFile.name),
                                permissions: 0,
                                modifiedS: 0,
                                modifiedNs: 0,
                                modifiedBy: new Uint8Array(0),
                                flags: 0,
                                sequence: 0,
                                version: '',
                                sync: SyncStatus.none,
                                files: [file]
                            });
                        }
                    }
                }
                return index;
            }

            else if (type === 'Response') {
                const response : Response = {
                    id: decodedMessage['id'],
                    data: decodedMessage['data'],
                    code: decodedMessage['code'],
                };

                return response;
            }

            else if (type === 'Ping') {
            }

            // only used internally to this class, so safe to ignore properties
            else if (type === 'Header') {
                return decodedMessage;
            }

            // only used internally to this class, so safe to ignore properties
            else if (type === 'Hello') {
                return decodedMessage;
            }

            // DO NOT blindly return any type, this whole point of this function is
            // to limit messages to those that are known and are correctly decoded
            else {
                throw('unknown type ' + type);
            }
        }
        catch (e) {
            if (e instanceof util.ProtocolError) {
                console.error('Communication::decodeMessage: unable to decode message, required fields missing', type);
            }
            else {
                console.error('Communication::decodeMessage: unable to decode message', e);
            }
        }
    }

    private startPingTimer() {
    	console.debug('Communication::ping: restart interval');
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }

        // Start ping timer
        this.pingTimer = setInterval(() => {
            console.debug('Communication::ping: sent');
            this.sendMessage(new Uint8Array(0), 'PING', 'NONE');
        }, 90000);
    }

    private sendHello() {
        const helloMessage = this.encodeMessage('Hello', {
            deviceName: this.deviceName,
            clientName: CLIENT_NAME,
            clientVersion: 'v' + VERSION,
        });

        const data = new Uint8Array(helloMessage.length + 6);
        const dataView = new DataView(data.buffer);

        // set magic number and message length and hello message
        dataView.setUint32(0, 0x2EA7D90B);
        dataView.setUint16(4, helloMessage.length);
        for (let i=0; i<helloMessage.length; i++) {
            data[i+6] = helloMessage[i];
        }

        this.socket.write(data);
    }

    private sendMessage(message: Uint8Array, type: number | string, compression: number | string) {
        // create header
        const headerMessage = this.encodeMessage('Header', {
            type: type,
            compression: compression,
        });

        // total length is header length + message length + 6 bytes for length fields
        const data = new Uint8Array(message.length + headerMessage.length + 6);
        const dataView = new DataView(data.buffer);
        // add header length and header
        dataView.setUint16(0, headerMessage.length);
        for (let i=0; i<headerMessage.length; i++) {
            data[i+2] = headerMessage[i];
        }

        // add message length and message
        dataView.setUint32(headerMessage.length + 2, message.length);
        for (let i=0; i<message.length; i++) {
            data[i+headerMessage.length+6] = message[i];
        }

        this.socket.write(data);
    }

    private async receiveMessage(data: Uint8Array) {
        let dataOffset = 0;

        // this function can receive multiple calls with parts of a single message
        if (this.message.state === MessageState.start) {
            const dataView = new DataView(data.buffer);
            this.message.headerLength = dataView.getUint16(0);
            this.message.length = dataView.getUint32(this.message.headerLength + 2);
            // +6 for header length bytes (2) + message length bytes (4)
            this.message.data = data.slice(this.message.headerLength + 6);

            // test to see if we have received the whole message
            if (this.message.length < this.message.data.length) {
                console.error('Communication::receiveMessage: malformed message received, message data is larger than message length in header');
            }

            // merge protobuf message with defaults
            const headerData = data.slice(2, this.message.headerLength + 2);
            let header = {
                type: 0,
                compression: 0,
            };
            header = {
                ...header,
                ...this.decodeMessage('Header', headerData)
            };

            this.message.type = header.type;
            this.message.compression = header.compression;
            this.message.received = 0;

            // if LZ4 compression used
            if (this.message.compression) {
                this.message.decompressedLength = dataView.getUint32(this.message.headerLength + 6);

                if (this.extraDebugging) {
                    console.debug('Communication::receiveMessage: message length decompressed ' + this.message.decompressedLength);
                }

                this.message.data = new Uint8Array(this.message.decompressedLength);
                dataOffset = this.message.headerLength + 10;

                // decompressed message length is counted as part of message length
                // it is not part of LZ4 block, so reduce message length
                this.message.length -= 4;
            }
            else {
                this.message.data = new Uint8Array(this.message.length);
                dataOffset = this.message.headerLength + 6;
            }

            if (this.extraDebugging) {
                console.debug('Communication::receiveMessage: header length ' + this.message.headerLength);
                console.debug('Communication::receiveMessage: message length from header ' + this.message.length);
                console.debug('Communication::receiveMessage: message header', header);
            }
        }

        // add new data to message buffer
        for (let i=dataOffset; i<data.length; i++) {
            this.message.data[this.message.received++] = data[i];
        }

        if (this.extraDebugging) {
            console.debug('Communication::receiveMessage: message bytes ' + this.message.received);
        }

        if (this.message.received + dataOffset >= this.message.length) {
            this.message.state = MessageState.start;

            // if LZ4 compression used
            if (this.message.compression) {
                //console.debug('Communication::receiveMessage: decompressing');
                const decompressedData = new Uint8Array(this.message.decompressedLength)
                decompressBlock(this.message.data, decompressedData, 0, this.message.length, 0);
                this.message.data = decompressedData;
            }

            const messageString = this.typeToString(this.message.type);
            if (messageString !== null) {
                const message = this.decodeMessage(messageString, this.message.data);

                if (this.extraDebugging) {
                    console.debug(JSON.stringify(message, null, 4));
                    console.debug(JSON.stringify(message).substr(0, 10000));
                }

                this.event.emit('message', this.message.type, message);
            }
        }
        else {
            this.message.state = MessageState.continue;
        }
    }

    constructor(certPath: string, keyPath: string, deviceName: string, extraDebugging = false) {

        // TODO: if certPath or keyPath does not exist create certificates

        this.deviceName = deviceName;
        this.extraDebugging = extraDebugging;

        this.message = {
            type: 0,
            compression: 0,
            headerLength: 0,
            length: 0,
            decompressedLength: 0,
            received: 0,
            data: null,
            state: MessageState.start
        };

        const socketOptions = {
            cert: readFileSync(certPath),
            key: readFileSync(keyPath),
            rejectUnauthorized: false
        };

        this.localId = Authentication.fromCertificate(socketOptions.cert);
        console.info('Communication:: device ID is: ', this.localId.asString);

        this.socket = new PeerSocket(socketOptions, extraDebugging);
    }

    destructor() {
        this.socket.destructor();
    }

    typeToString(type: number): string {
        if (type < 0 || type > 7) {
            return null;
        }
        else {
            return this.TYPE_TO_MESSAGE[type];
        }
    }

    async connect(url: string, peerId: DeviceId) {

        await this.loadProtocol();
        this.socket.connect(url, peerId);

        this.socket.on('secureConnect', () => {
            // Hello must be sent on connect
            this.sendHello();

            // start ping timer
            this.startPingTimer();
        });

        this.socket.on("data", (data) => {
            // if in pre-auth state, look for magic number, then decode hello message
            const dataView = new DataView(data.buffer);
            if (dataView.getUint32(0) === 0x2EA7D90B) {
                console.debug('Communication::onData:', this.decodeMessage('Hello', data.slice(6)));
                this.event.emit('connect');
            }
            else {
                this.receiveMessage(data);
            }
        });

        this.socket.on('close', () => {
            console.log('Communication::onClose: connection closed');
            this.event.emit('close');
        });

        this.socket.on('error', (error) => {
            console.error('Communication::onError:', error);
            this.event.emit('error', error);
        });
    }

    on(event: string, listener: any) {
        this.event.on(event, listener);
    }

    sendClusterConfig(cluster: Cluster) {
        const clusterConfigMessage = this.encodeMessage('ClusterConfig', cluster);
        this.sendMessage(clusterConfigMessage, 'CLUSTER_CONFIG', 'NONE');
    }

    requestBlock(blockRequest: BlockRequest) {
    	let name = blockRequest.name;
    	if (blockRequest.name.charAt(0) === '/') {
    	    name = name.substring(1);
    	}

        const request = {
        	id: blockRequest.id,
            folder: blockRequest.folder,
            name: name,
            offset: blockRequest.block.offset,
            size: blockRequest.block.size,
        };

        if (this.extraDebugging) {
            console.debug('Communication::requestBlock: block requested', request);
        }

        const requestMessage = this.encodeMessage('Request', request);
        this.sendMessage(requestMessage, 'REQUEST', 'NONE');
    }
}
