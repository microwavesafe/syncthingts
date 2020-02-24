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

import { Socket, connect as insecureConnect } from 'net';
import { TLSSocket, connect, TLSSocketOptions } from 'tls';
import { EventEmitter } from 'events';
import { URL } from 'url';

import Authentication, { DeviceId } from './authentication';

enum RelayMessageType {
    JoinSessionRequest = 3,
    Response = 4,
    ConnectRequest = 5,
    SessionInvitation = 6,
};

enum SessionJoinResponse {
    ResponseNotFound = 1,
    ResponseAlreadyConnected = 2,
    ResponseSuccess = 3,
};

interface RelayMessage {
    type: number;
    length: number;
    data: Uint8Array;
    message: SessionInvitationMessage | ResponseMessage
};

interface ResponseMessage {
    code: number;
    messageLength: number;
    message: Uint8Array;
};

interface SessionInvitationMessage {
    fromLength: number;
    from: Uint8Array;
    keyLength: number;
    key: Uint8Array;
    addressLength: number;
    address: Uint8Array;
    port: number;
};

export default class PeerSocket {
    private extraDebugging: boolean;
    private socketOptions: TLSSocketOptions;
    private insecureSocket: Socket;
    private socket: TLSSocket;

    private event = new EventEmitter();

    private peerId: DeviceId;


    private relayProtocolAddHeader(dataView: DataView, type: number, length: number) {
        // magic value
        dataView.setUint32(0, 0x9E79BC40);
        dataView.setUint32(4, type);
        dataView.setUint32(8, length);
    }

    private relayProtocolDecodeMessage(data: Uint8Array) : RelayMessage {
        let dataView = new DataView(data.buffer);

        if (data.length < 12 || dataView.getUint32(0) !== 0x9E79BC40) {
            console.error('PeerSocket::relayProtocolDecodeMessage too short or invalid magic value');
            return {
                type: 255,
                length: 0,
                data: new Uint8Array(),
                message: null,
            };
        }

        const decoded : RelayMessage = {
            type: dataView.getUint32(4),
            length: dataView.getUint32(8),
            data: data.subarray(12),
            message: null,
        };

        switch (decoded.type) {
            case RelayMessageType.SessionInvitation: {
                try {
                    const fromLengthIndex = 12;
                    const fromIndex = fromLengthIndex + 4;
                    const fromLength = dataView.getUint32(fromLengthIndex);
                    const keyLengthIndex = fromIndex + fromLength;
                    const keyIndex = keyLengthIndex + 4;
                    const keyLength = dataView.getUint32(keyLengthIndex);
                    const addressLengthIndex = keyIndex + keyLength;
                    const addressIndex = addressLengthIndex + 4;
                    const addressLength = dataView.getUint32(addressLengthIndex);
                    const portIndex = 2 + addressIndex + addressLength;

                    decoded.message = {
                        fromLength: fromLength,
                        from: data.subarray(fromIndex, fromIndex + fromLength),
                        keyLength: keyLength,
                        key: data.subarray(keyIndex, keyIndex + keyLength),
                        addressLength: addressLength,
                        address: data.subarray(addressIndex, addressIndex + addressLength),
                        port: dataView.getUint16(portIndex),
                    }
                }
                catch (e) {
                    if(e instanceof RangeError) {
                        console.error('PeerSocket::relayProtocolDecodeMessage: invalid session invitation length');
                    }
                    else {
                        console.error('PeerSocket::relayProtocolDecodeMessage: session invitation error', e);
                    }
                }
                break;
            }

            case RelayMessageType.Response: {
                try {
                    const codeIndex = 12;
                    const messageLengthIndex = codeIndex + 4;
                    const messageIndex = messageLengthIndex + 4;
                    const messageLength = dataView.getUint32(messageLengthIndex);

                    decoded.message = {
                        code: dataView.getUint32(codeIndex),
                        messageLength: messageLength,
                        message: data.subarray(messageIndex, messageIndex + messageLength),
                    };
                }
                catch (e) {
                    if(e instanceof RangeError) {
                        console.error('PeerSocket::relayProtocolDecodeMessage: invalid response length');
                    }
                    else {
                        console.error('PeerSocket::relayProtocolDecodeMessage: response error', e);
                    }
                }
                break;
            }
        }

        return decoded
    }

    private relayProtocolConnectRequest(peerDeviceId: DeviceId) : Uint8Array {
        const connectRequest = new Uint8Array(48);
        const connectRequestView = new DataView(connectRequest.buffer);
        // message length is length of message only, not including header
        this.relayProtocolAddHeader(connectRequestView, RelayMessageType.ConnectRequest, 36);
        // length of ID is fixed for this connection request type
        connectRequestView.setUint32(12, 32);
        // add peer ID
        for (let i=0; i<32; i++) {
            connectRequest[i+16] = peerDeviceId.asBytes[i];
        }

        return connectRequest;
    }

    private relayProtocolJoinSessionRequest(key: Uint8Array) : Uint8Array {
        const message = new Uint8Array(key.length + 16);
        const messageView = new DataView(message.buffer);
        this.relayProtocolAddHeader(messageView, RelayMessageType.JoinSessionRequest, key.length + 4);
        messageView.setUint32(12, key.length);
        // add key
        for (let i=0; i<key.length; i++) {
            message[i+16] = key[i];
        }

        return message;
    }

    private relayRequest(message: Uint8Array, socket: Socket | TLSSocket, authId?: DeviceId) : Promise<RelayMessage> {
    	let connectEvent = 'connect';
    	if (socket instanceof TLSSocket) {
    	    connectEvent = 'secureConnect';
    	}

        return new Promise ((resolve, reject) => {
        	socket.setTimeout(10000);
            socket.on('timeout', () => {
                console.error( 'PeerSocket::relayRequest: timeout when negotiating with relay server');
                socket.destroy();
                reject();
            });
            socket.on('error', (error) => {
                console.error( 'PeerSocket::relayRequest: error when negotiating with relay server', error);
                socket.destroy();
                reject();
            });
            socket.on('close', () => {
                console.debug('PeerSocket::relayRequest: closed');
                // if we have data resolve otherwise reject
                socket.destroy();
                reject();
            });
            socket.on(connectEvent, () => {
            	if (socket instanceof TLSSocket) {
            	    const connectedRelayId = Authentication.fromSocket(socket);
                    if (connectedRelayId.asString !== authId.asString) {
                    	console.error('PeerSocket::relayRequest: relay authentication failed', connectedRelayId.asString);
                        socket.destroy();
                        reject();
                        return;
                    }

                    console.debug('PeerSocket::relayRequest: relay id', connectedRelayId.asString);
            	}

                console.debug('PeerSocket::relayRequest: connected to relay');
                socket.write(message);
            });
            socket.on('data', (data) => {
                if (this.extraDebugging) {
                    console.debug('PeerSocket::relayRequest:data', data);
                }
                socket.setTimeout(0);
                socket.removeAllListeners();
                resolve(this.relayProtocolDecodeMessage(data));
            });
        });
    }

    constructor(socketOptions: TLSSocketOptions, extraDebugging = false) {
        this.extraDebugging = extraDebugging;
        this.socketOptions = socketOptions;
    }

    destructor() {
        if (this.socket) {
            this.socket.end();
        }
        if (this.insecureSocket) {
            this.insecureSocket.end();
        }
    }

    async connect(url: string, peerId: DeviceId) {
        this.peerId = peerId;
        const parsedURL = new URL(url);
        const port = parseInt(parsedURL.port);

        if (port === NaN) {
            console.error('PeerSocket::connect: invalid port', parsedURL.port);
            return;
        }

        console.debug('PeerSocket::connect: connecting to Syncthing remote');

        // do we need to access this device via relay
        if (parsedURL.protocol === 'relay:') {
            try {
            	// get relay device id to authenticate relay
                const relayId = parsedURL.searchParams.get('id');
                if (relayId === null) {
                	console.error('PeerSocket::connect: no relay device id');
                }

            	// start by contacting relay to request connection
                const relayProtocolSocket = connect(port, parsedURL.hostname, this.socketOptions);
                const connectRequestReply = await this.relayRequest(
                    this.relayProtocolConnectRequest(peerId),
                    relayProtocolSocket,
                    Authentication.fromString(relayId)
                 );

                // socket is closed at server end after reply anyway
                relayProtocolSocket.destroy();

                if (connectRequestReply.type !== RelayMessageType.SessionInvitation) {
                    console.error('PeerSocket::connect: reply to connect request is not session invitation', connectRequestReply);
                    return;
                }

                console.debug('PeerSocket::connect: received session invitation message');
                const sessionInvitation = <SessionInvitationMessage>connectRequestReply.message;
                const relaySessionSocket = insecureConnect(sessionInvitation.port, parsedURL.hostname);
                const sessionRequestReply = await this.relayRequest(
                    this.relayProtocolJoinSessionRequest(sessionInvitation.key),
                    relaySessionSocket
                );

                if (sessionRequestReply.type !== RelayMessageType.Response) {
                    console.error('PeerSocket::connect: reply to join session request is not response', sessionRequestReply);
                    relaySessionSocket.destroy();
                    return;
                }

                const response = <ResponseMessage>sessionRequestReply.message;
                if (response.code === SessionJoinResponse.ResponseNotFound) {
                    console.error('PeerSocket::connect: session key not found', sessionInvitation.key);
                    relaySessionSocket.destroy();
                    return;
                }

                console.debug('PeerSocket::connect: successfully negotiated relay');
                // wrap insecure socket in TLS
                this.insecureSocket = relaySessionSocket;
                this.socket = connect({
                    socket: this.insecureSocket,
                    ...this.socketOptions
                });
            }
            catch {
            	return;
            }
        }
        else if (parsedURL.protocol === 'tcp:') {
            this.socket = connect(port, parsedURL.hostname, this.socketOptions);
        }
        else {
            console.error('PeerSocket::connect: invalid protocol', parsedURL.protocol);
            return;
        }

        this.socket.on('secureConnect', () => {
        	// NOTE: we do NOT need to check client.authorised as default
            // Syncthing server setup does not use signed certificates
        	const connectedPeerId = Authentication.fromSocket(this.socket);
            if (connectedPeerId.valid === false ||
            connectedPeerId.asString !== this.peerId.asString) {
                this.event.emit('error', 'remote device ID failed authentication');
                return;
            }

            console.info('PeerSocket::connect: remote device ID is: ', connectedPeerId.asString);

            // start inactivity time
            this.socket.setTimeout(90000 * 3);
            this.event.emit('secureConnect');
        });

        this.socket.on('timeout', () => {
            this.socket.end();
            if (this.insecureSocket) {
                this.insecureSocket.end();
            }
        });

        this.socket.on("data", (data) => {
            if (this.extraDebugging) {
                console.debug('PeerSocket::onData: received ' + data.length);
            }

            this.event.emit('data', data);
        });

        this.socket.on('close', () => {
            this.event.emit('close');
            if (this.insecureSocket) {
                this.insecureSocket.end();
            }
        });

        this.socket.on('error', (error) => {
            this.event.emit('error');
            this.socket.destroy();
            if (this.insecureSocket) {
                this.insecureSocket.destroy();
            }
        });
    }

    write(data: Uint8Array) {
        if (this.extraDebugging) {
            console.debug('PeerSocket::write: writing to socket', data);
        }
        this.socket.write(data);
    }

    on(event: string, listener: any) {
        this.event.on(event, listener);
    }
}
