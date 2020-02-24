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

import { EventEmitter } from 'events';

import { Cluster, Index, Response, ListEntry, ListEntryType  } from './constants';
import { DiscoverReply, discover } from './discover';
import Communication, { ProtocolMessage } from './communication';
import Database from './database';
import File from './file';
import Authentication, { DeviceId } from './authentication';
import Request, { BlockRequest, RequestPriority } from './request';

// number of concurrent blocks to request
const CONCURRENT_BLOCK_REQUESTS = 5;
// timeout to flag request as failed
const BLOCK_REQUEST_TIMEOUT = 2000;

interface BlockRead {
	blockRequest: BlockRequest;
	data: Promise<Uint8Array>;
};

export default class Syncthing {
	private requests: Request;
    private database: Database;
    private communication: Communication;
    private cachePath: string;
    private peerId: DeviceId;
    private event = new EventEmitter();

    private requestBlocks() {
/*     	const queueLength = this.requests.queueLength();
        const numRequests = (10 * CONCURRENT_BLOCK_REQUESTS) - queueLength;

        // if we have less than 2 * the concurrent limit try to fill it to 10 *
        // this will reduce database reads
        if (queueLength < (2 * CONCURRENT_BLOCK_REQUESTS)) {
            const blocks = this.database.blocksToRequest(numRequests);
            for (const block of blocks) {
                this.requests.add(block.file_id, block.folder_id, block.name, block.size, block.offset, block.hash, RequestPriority.background);
            }
        } */
    }

    private deleteBlocks() {
        //const blocks = this.database.blocksToDelete(20);
        // TODO: delete cached blocks and remove from database
    }

    private async processPeerMessage(type: ProtocolMessage, message: Cluster | Index | Response) {
        switch (type) {
            case ProtocolMessage.CLUSTER_CONFIG: {
                try {
                    const cluster = <Cluster>message;
                    // if we received the ClusterConfig message, send ours back
                    // wait until remote device has sent, initially we have no state
                    this.database.updateClusterConfig(cluster);
                    const clusterConfig = this.database.getClusterConfig(this.peerId.asBytes);
                    this.communication.sendClusterConfig(clusterConfig);

                    // MUST exchange cluster config messages before anything else
                    // check if any blocks need requesting
                    //self.requestBlocks();

                    // clients can't perform any communication with peer until we have
                    // exchanged cluster configs, so wait until then to signal connected
                    this.event.emit('connected');
                }
                catch (e) {
                    console.error('Core::processPeerMessage: cluster config error', e);
                }
                break;
            }

            case ProtocolMessage.INDEX:
            case ProtocolMessage.INDEX_UPDATE: {
                try {
                    const index = <Index>message;
                    if (this.database.updateIndex(index)) {
                        this.requestBlocks();
                        this.deleteBlocks();

                        this.event.emit('updated');
                    }
                }
                catch (e) {
                    console.error('Core::processPeerMessage: index update error', e);
                }
                break;
            }

            case ProtocolMessage.RESPONSE: {
                try {
                    const response = <Response>message;
                    console.debug('Core::processMessage: response', response.id);

                    if (response.code !== 0) {
                        // TODO: we have an error decide what to do
                        // 1 - generic error (?)
                        // 2 - no such file, clear requestBlocks
                        // 3 - invalid, file exists, but invalid bit set
                        console.error('Core::processPeerMessage: response has error code');
                        return;
                    }

                    // requests.received function checks hash matches db entry
                    const blockRequest: BlockRequest = this.requests.received(response.id, response.data);
                    if (blockRequest) {
                        console.debug('Core::processPeerMessage: response block found and hash matches', blockRequest);
                        const path = File.path(this.cachePath, blockRequest.folder, blockRequest.fileId, blockRequest.block.offset);
                        await File.writeBlock(path, response.data);
                        // writeBlock will throw on error, so this wont run
                        blockRequest.block.cached = 1;
                        this.database.updateBlock(blockRequest);
                    }
                    else {
                        console.error('Core::processPeerMessage: response block not found');
                    }
                }
                catch(e) {
                    console.error('Core::processPeerMessage: response error', e);
                }
                break;
            }
        }
    }

    constructor(name: string, cachePath: string, certPath: string, keyPath: string, dbPath: string) {
        this.cachePath = cachePath;
        console.debug('Core:: caching to path', this.cachePath);

        this.communication = new Communication(certPath, keyPath, name, false);

        this.communication.on('message', async (type, message) => {
            await this.processPeerMessage(type, message);
        });

        this.communication.on('error', () => {
            this.event.emit('error');
        });

        this.communication.on('close', () => {
            this.event.emit('error');
        });

        this.database = new Database(dbPath, name, this.communication.localId.asBytes, true);

        this.requests = new Request(
            (block) => {
            	console.debug('Synthing::Request:send', block);
            	this.communication.requestBlock(block);
            },
            () => {
            	this.requestBlocks();
            },
            CONCURRENT_BLOCK_REQUESTS,
            BLOCK_REQUEST_TIMEOUT
        );
    }

    async destructor() {
    	this.requests.destructor();

        if (this.communication) {
            this.communication.destructor();
        }
        if (this.database) {
            this.database.destructor();
        }
    }

    on(event: string, listener: any) {
        this.event.on(event, listener);
    }

    async connect(url: string, peerIdString: string) {
    	this.peerId = Authentication.fromString(peerIdString);
        if (this.peerId.valid === false) {
        	console.error('Core::connect: invalid peer ID', peerIdString);
            return;
        }

        // if set to dynamic, check discovery servers for addresses
        if (url === 'dynamic') {
            try {
                const discoverReply: DiscoverReply = await discover('https://discovery.syncthing.net/?device=' + this.peerId.asString);
                if (discoverReply.addresses.length > 0) {
                    url = discoverReply.addresses[0];
                }
                else {
                    console.error('Core::connect: could not discover address for peer');
                    return;
                }
            }
            catch {
                return;
            }
        }

        try {
            await this.communication.connect(url, this.peerId);
        }
        catch (err) {
            console.error('Core::connect: failed to connect', err);
            this.event.emit('error');
        }
    }

    // path should start with folder.path
    attributes(path: string) : ListEntry | null {
        if (typeof path !== 'string') {
            console.error('Core::attributes: path is not a string');
            return null;
        }
        console.debug('Core::attributes:', path);
        try {
            return this.database.attributes(path);
        }
        catch(e) {
            console.error('Core::attributes: error', e);
            return null;
        }
    }

    list(path: string) : ListEntry[] {
        if (typeof path !== 'string') {
            console.error('Core::list: path is not a string');
            return [];
        }
        console.debug('Core::list:', path);
        try {
            return this.database.list(path);
        }
        catch(e) {
            console.error('Core::list: error', e);
            return [];
        }
    }

    async read(path: string, position: number, length: number) : Promise<Uint8Array> {

        if (length > 10485760) {
            console.error('Core::read: requested length more than 10MB');
            return new Uint8Array(0);
        }

        try {
            const blockRequests : BlockRequest[] = this.database.blocksToSatisfyRead(
                path,
                position,
                length
            );

            console.debug('Core::read: required blocks', blockRequests);
            const readData = new Uint8Array(length);
            const blockReads : BlockRead[] = [];

            let data : Promise<Uint8Array>;
            for (const blockRequest of blockRequests) {
                // if db says it's cached, try reading block and check hash
                if (blockRequest.block.cached === 1) {
                    const path = File.path(this.cachePath, blockRequest.folder, blockRequest.fileId, blockRequest.block.offset);
                    data = File.readBlock(path, blockRequest.block.size, blockRequest.block.hash);
                }
                // for any block not cached, request with high priority
                else {
                    data = this.requests.wait(blockRequest, RequestPriority.user);
                }
                blockReads.push({
                    data: data,
                    blockRequest: blockRequest
                });
            }

            // wait for the request or cached data
            let readOffset = 0;
            while (blockReads.length) {
                const blockRequest = blockReads[0].blockRequest;
                const block = blockRequest.block;
                const blockData = await blockReads[0].data;

                if (blockRequest.block.cached === 1) {
                    // if cached block fails to read or incorrect hash
                    // the function returns a 0 length data array
                    if (blockData.length === 0) {
                        block.cached = 2;
                        this.database.updateBlock(blockRequest);
                        blockReads[0].data = this.requests.wait(blockRequest, RequestPriority.user);
                        continue;
                    }
                }
                // remote requests ate already verified

                const relativeStart = position - block.offset;
                const start = relativeStart < 0 ? 0 : relativeStart;
                const relativeEnd = relativeStart + length;
                const end = relativeEnd > block.size ? block.size : relativeEnd;

                console.debug('Core::read: sub array start, end, offset', start, end, readOffset);
                readData.set(blockData.subarray(start, end), readOffset);
                readOffset += end - start;

                // remove first block from read list
                blockReads.shift();
            }

            return readData.subarray(0, readOffset);
        }
        catch (err) {
            console.error('Core::read: read failed to get required blocks', err);
            new Uint8Array(0);
        }
    }
}
