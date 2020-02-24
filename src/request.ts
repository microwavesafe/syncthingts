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

import * as crypto from 'crypto';
import { Block } from './constants';

/* Because of the single threaded nature of node
 * I believe I am correct in thinking the functions
 * that work on the queue do not need a mutex
 */

export enum RequestPriority {
	background = 0,
	user,
};

/* TODO: create external interface for requesting blocks */

export interface BlockRequest {
	id: number;
    fileId: number;
    folder: string;
    name: string;
    block: Block;
};

interface QueuedBlock {
    active: boolean;
    retries: number;
    timeout: any;
    blockRequest: BlockRequest;
    priority: number;
    callback?: Function,
};

export default class Request {
	private send: Function;
    private queueChange: Function;

    private requests: QueuedBlock[];
    private id: number;

    private concurrent: number;
    private timeout: number;
    private totalActive: number;
    private retries: number;

	private incrementId() {
        this.id++;
        if (this.id > Number.MAX_SAFE_INTEGER-1) {
            this.id = 1;
        }
    }

    private enqueue(request: QueuedBlock) {
    	this.requests.push(request);
        this.queueChange();
    }

    private dequeue(index: number) {
    	const request = this.requests.splice(index, 1)[0];
        this.queueChange();
        return request;
    }

    private process(): boolean {

        if (this.requests.length === 0 || this.totalActive >= this.concurrent) {
            return false;
        }

        // sort queue by priority
        this.requests.sort((a, b) => a.priority - b.priority);

        // request top of list up to set concurrency level
        for (let i = 0; i < this.requests.length; i++) {
            const request = this.requests[i];
            if (!request.active) {
                this.incrementId();
                request.blockRequest.id = this.id;
                request.active = true;

                console.debug('Request::process', request.blockRequest.id, request.blockRequest.name);
                this.send(request.blockRequest);

                const index = i;
                request.timeout = setTimeout(() => {
                    if (request.retries < this.retries) {
                        request.blockRequest.id = 0;
                        request.active = false;
                        request.retries++;
                        console.debug('Request::process: timeout', request.retries);
                    }
                    else {
                        if (typeof request.callback === 'function') {
                    	    request.callback('timeout');
                    	}
                        this.dequeue(index);
                    }

                    this.totalActive--;
                    this.process();
                }, this.timeout);

                this.totalActive++;
                console.debug('Request::process: active requests', this.totalActive);

                if (this.totalActive >= this.concurrent) {
                    break;
                }
            }
        }
    }

    constructor(send: Function, queueChange: Function, concurrent: number, timeout: number, retries: number = 2) {
        this.requests = [];
        this.id = 1;
        this.totalActive = 0;

        this.send = send;
        this.queueChange = queueChange;
        this.concurrent = concurrent;
        this.timeout = timeout;
        this.retries = retries;
    }

    destructor() {
    	for (const request of this.requests) {
    	    clearTimeout(request.timeout);
    	}
        this.requests = [];
    }

    add(blockRequest: BlockRequest, priority: number, callback?: Function) {
        for (const request of this.requests) {
        	if (request.blockRequest.fileId === blockRequest.fileId
            && request.blockRequest.block.offset === blockRequest.block.offset) {
            	request.priority = priority;
                return;
            }
        }

    	const request : QueuedBlock = {
            active: false,
            priority: priority,
            retries: 0,
            timeout: undefined,
            callback: callback,
            blockRequest: blockRequest,
        };

        this.enqueue(request);
    	this.process();
    }

    async wait(block: BlockRequest, priority: number) : Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            this.add(block, priority,  (err, data) => {
                if (err) {
                    reject (err);
                }
                else {
                    resolve(data);
                }
            });
        });
    }

    remove(folder: string, name: string) : QueuedBlock | null {
        let request = null;
    	for (let i = 0; i < this.requests.length; i++) {
    	    while(1) {
    	        if (this.requests[i].blockRequest.folder === folder && this.requests[i].blockRequest.name === name) {
    	            clearTimeout(this.requests[i].timeout);
    	            request = this.dequeue(i);
                }
                else {
                	break;
                }
            }
    	}

        if (request != null) {
        	if (typeof request.callback === 'function') {
        	    request.callback('removed');
        	}
            this.process();
        }

        return request;
    }

    received(id: number, data: Buffer | Uint8Array) : BlockRequest | null {
    	console.debug('Request::received:', id);

        for (let i = 0; i < this.requests.length; i++) {
        	if (this.requests[i].blockRequest.id === id
            && this.requests[i].active) {
            	console.debug('Request::received: found queued item', i);
        	    clearTimeout(this.requests[i].timeout);
                const request = this.dequeue(i);
                this.totalActive--;
                this.process();

                const hash = crypto.createHash('sha256').update(data).digest();
                if (hash.equals(request.blockRequest.block.hash)) {
                	if (typeof request.callback === 'function') {
                	    request.callback(null, data);
                	}
                	return request.blockRequest;
                }
                else {
                    console.error('Request::received: response hash of downloaded block is not the same as expected');
                    return null;
                }
        	}
        }
        return null;
    }

    queueLength() {
    	return this.requests.length;
    }
}
