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

export const VERSION = "0.1.0";
export const CLIENT_NAME = "SyncthingCore";

export enum SyncStatus {
    none = 0,
    download,
    full,
};

export enum FileFlags {
    deleted = (1 << 0),
    invalid = (1 << 1),
    noPermissions = (1 << 2),
};

export interface Device {
    id: Uint8Array;
    folderIdString: string,
    name: string;
    addresses: string;
    maxSequence: number;
    indexId: Uint8Array;
};

export interface Folder {
    idString: string;
    label: string;
    path: string;
    flags: number;
    devices: Device[];
};

export interface Cluster {
    folders: Folder[];
};

export interface Block {
    offset: number;
    size: number;
    hash: Uint8Array;
    cached: number;
};

export interface File {
    name: string;
    size: number;
    permissions: number;
    modifiedS: number;
    modifiedNs: number;
    modifiedBy: Uint8Array;
    flags: number;
    sequence: number;
    blockSize: number;
    version: string;
    symlinkTarget: string;
    sync: number;
    blocks: Block[];
};

export interface Directory {
    // all paths MUST be absolute (it helps dirname and basename)
    name: string;
    permissions: number;
    modifiedS: number;
    modifiedNs: number;
    modifiedBy: Uint8Array;
    flags: number;
    sequence: number;
    version: string;
    sync: number;
    files: File[];
};

export interface Index {
    folder: string;
    directories: Directory[];
};

export interface Response {
    id: number;
    data: Uint8Array;
    code: number;
}

export enum ListEntryType {
	file = 0,
	directory = 1,
	symlink = 4,
};

export interface ListEntry {
	type: ListEntryType,
	name: string,
	size: number,
	permissions: number,
	modified: Date,
	modifiedBy: number,
};
