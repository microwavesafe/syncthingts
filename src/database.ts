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

import { join, parse, sep } from 'path';

import Sql, { FileRow, DirectoryRow } from './sqlite';
import { SyncStatus, Cluster, Folder, Device, Index, File, Directory, Block, FileFlags, ListEntry, ListEntryType  } from './constants';
import { BlockRequest } from './request';

interface SplitPath {
    folder: string;
    dir: string;
    file: string;
};

export default class Database {

    private sql: Sql;
    private deviceId: Uint8Array;
    private name: string;
    private extraDebugging: boolean;

    constructor(path: string, name: string, deviceId: Uint8Array, extraDebugging = false) {
        this.deviceId = deviceId;
        this.name = name;
        this.extraDebugging = extraDebugging;

        this.sql = new Sql(path, extraDebugging);

        // check database for inconsistencies
    }

    destructor() {
        this.sql.destructor();
    }

    private updateBlocks(fileId: number, blocks: Block[], connection: any) {

        let updated = false;

        // we need to remove old blocks as well as update edit new ones
        const blockRows = this.sql.getBlocks(fileId, connection);
        // make sure blocks from peer are ordered by offset (this doesn't seem to be guaranteed)
        // @ts-ignore
        blocks.sort((a, b) => {a.offset - b.offset});

        const loop = Math.max(blocks.length, blockRows.length);

        for (let i = 0; i < loop; i++) {
            let block = null;

            if (i < blocks.length) {
                block = blocks[i];

                if (i < blockRows.length) {
                    // test if equal, otherwise update
                    if (!this.sql.isRowEqual(block, blockRows[i], ['cached'])) {
                        if (this.extraDebugging) {
                            console.debug('Database::updateBlocks: updating block ' + block);
                        }

                        // if already cached then we need to set it as stale
                        if (blockRows[i].cached === 1) {
                            block.cached = 2;
                        }

                        // update existing row (uniquely identified with fileId and offset of exisiting row)
                        // with data from peer. this may change the offset and therefore the id of the block
                        this.sql.updateBlock(block, fileId, blockRows[i].offset, connection);
                        updated = true;
                    }
                }
                else {
                    if (this.extraDebugging) {
                        console.debug('Database::updateBlocks: inserting block ' + block);
                    }

                    block.cached = 0;
                    this.sql.addBlock(block, fileId, connection);
                    updated = true;
                }
            }
            // if we have more db entries than blocks from peers
            else {
                // if cached, set block size to 0 and cached to stale
                if (blockRows[i].cached) {
                    blockRows[i].size = 0;
                    blockRows[i].cached = 2;
                    this.sql.updateBlock(blockRows[i], fileId, blockRows[i].offset, connection);
                    updated = true;
                }
                // if not cached, just delete row
                else {
                    this.sql.deleteBlock(fileId, blockRows[i].offset, connection);
                }
            }
        }

        return updated;
    }

    private updateEntry(entry: File | Directory, entryRow: FileRow | DirectoryRow, parentSync: number, sequence: number, connection: any) {
        const result = {
            updated: false,
            add: false,
            update: false,
            sequence: sequence,
            valid: false,
        };

        // if doesn't exist
        if (entryRow === null) {
            // if we have no record of it and it is already deleted we don't need to do anything
            // including add any files, we can't have had any files in the database with this
            // parent directory, otherwise we would have had an entry
            if (entry.flags & FileFlags.deleted) {
                return result;
            }

            entry.sequence = result.sequence++;
            // set sync to same as parent directory
            entry.sync = parentSync;
            if (parentSync === SyncStatus.full) {
                result.updated = true;
            }

            result.add = true;
        }
        // else update
        else {
            // test if equal, otherwise update, ignore sequence number
            if (!this.sql.isRowEqual(entry, entryRow, ['sequence'])) {
                entry.sequence = result.sequence++;

                if (entryRow.sync === SyncStatus.full) {
                    result.updated = true;
                }

                result.update = true;
            }
        }

        result.valid = true;
        return result;
    }

    updateIndex(index: Index) {
        console.debug('Database::updateIndex: updating index', index.folder);

        let connection;
        let updated = false;
        try {
            // always start a transaction for multiple writes, time saving is orders of magnitude
            connection = this.sql.startTransaction();

            const folderRow =  this.sql.getFolder(index.folder, connection);
            if (folderRow === null) {
                throw('no folder exists for incoming index update, ' + index.folder);
            }

            const deviceRow = this.sql.getDevice(folderRow.id, this.deviceId, connection);
            if (deviceRow === null) {
                throw('no device exists for this folder, ' + index.folder);
            }
            let sequence = deviceRow.maxSequenceInternal;

            // we have to have a root directory entry, test for and add if necessary
            const rootDirectoryRow = this.sql.getDirectory(folderRow.id, '/', connection);
            if (rootDirectoryRow === null) {
                this.sql.addDirectory({
                    name: '/',
                    permissions: 493,
                    flags: 0,
                    sequence: sequence++,
                    sync: 0,
                    modifiedS: 0,
                    modifiedNs: 0,
                    modifiedBy: new Uint8Array(0),
                    version: '',
                    files: [],
                }, folderRow.id, connection);
            }

            for (const directory of index.directories) {
                let sync = 0;

                // if index of '/' is 0 then root folder and no parent
                const lastSeparator = directory.name.lastIndexOf('/');
                if (lastSeparator > 0) {
                    const parentDirectoryRow = this.sql.getDirectory(
                        folderRow.id,
                        directory.name.substring(0, lastSeparator),
                        connection
                    );

                    // if we have a parent set sync to match
                    if (parentDirectoryRow !== null) {
                        sync = parentDirectoryRow.sync;
                    }
                }

                // see if an entry already exists
                const directoryRow = this.sql.getDirectory(folderRow.id, directory.name, connection);
                let directoryId: number;

                const entryResult = this.updateEntry(directory, directoryRow, sync, sequence, connection);
                if (entryResult.valid === false) {
                    continue;
                }

                if (entryResult.add) {
                    if (this.extraDebugging) {
                        console.debug('Database::updateIndex inserting directory ', directory);
                    }
                    directoryId = this.sql.addDirectory(directory, folderRow.id, connection).lastInsertRowid;
                }
                else {
                    directoryId = directoryRow.id;
                    if (entryResult.update) {
                        if (this.extraDebugging) {
                            console.debug('Database::updateIndex updating directory ' + directory);
                        }
                        this.sql.updateDirectory(directory, folderRow.id, directoryRow.id, connection);
                    }
                }

                if (entryResult.updated) {
                    updated = true;
                }
                sequence = entryResult.sequence;

                for (const file of directory.files) {

                    const fileRow = this.sql.getFile(directoryId, file.name, connection);
                    let fileId: number;

                    const entryResult = this.updateEntry(file, fileRow, sync, sequence, connection);
                    if (entryResult.valid === false) {
                        continue;
                    }

                    if (entryResult.add) {
                        if (this.extraDebugging) {
                            console.debug('Database::updateIndex inserting file ', file);
                        }
                        fileId = this.sql.addFile(file, directoryId, connection).lastInsertRowid;
                    }
                    else {
                        fileId = fileRow.id;
                        if (entryResult.update) {
                            if (this.extraDebugging) {
                                console.debug('Database::updateIndex updating file ' + file);
                            }
                            this.sql.updateFile(file, directoryId, fileId, connection);
                        }
                    }

                    if (entryResult.updated) {
                        updated = true;
                    }
                    sequence = entryResult.sequence;

                    if (this.updateBlocks(fileId, file.blocks, connection)) {
                        updated = true;
                    }
                }
            }

            // update max sequence, important this is done inside transaction
            if (updated) {
                this.sql.updateSequence(this.deviceId, folderRow.id, sequence, connection);
            }

            this.sql.commitTransaction(connection);
            console.debug('Database::updateIndex: finished updating ' + index.folder);
        }
        catch (err) {
            this.sql.rollbackTransaction(connection);
            console.error('Database::updateIndex: ' + err);
        }

        return updated;
    }

    getClusterConfig(peerId: Uint8Array) : Cluster {
        try {
            const folderRows = this.sql.getFolders();

            if (folderRows.length === 0) {
                console.error('Database::getClusterConfig: no folders configured');
            }

            const cluster: Cluster = {
                folders: [],
            };

            // we can simplify as we enforce one peer therefore we only
            // need to send this device and peer device info
            for (const folderRow of folderRows) {
                const folder: Folder = {
                    idString: folderRow.idString,
                    label: folderRow.label,
                    path: folderRow.path,
                    flags: folderRow.flags,
                    devices: [],
                };

                const self = this.sql.getDevice(folderRow.id, this.deviceId);
                const deviceSelf: Device = {
                    id: this.deviceId,
                    name: self.name,
                    indexId: self.indexId,
                    maxSequence: self.maxSequenceInternal,
                    folderIdString: folder.idString,
                    addresses: self.addresses,
                };
                folder.devices.push(deviceSelf);

                const peer = this.sql.getDevice(folderRow.id, peerId);
                const devicePeer: Device = {
                    id: peerId,
                    name: peer.name,
                    indexId: peer.indexId,
                    maxSequence: peer.maxSequenceInternal,
                    folderIdString: folder.idString,
                    addresses: peer.addresses,
                };
                folder.devices.push(devicePeer);

                cluster.folders.push(folder);
            }

            console.debug('Database::getClusterConfig: compiled cluster', cluster);
            return cluster;
        }
        catch (err) {
            console.error('Database::getClusterConfig: unable to get cluster device info');
            console.error(err);
        }
    }

    updateClusterConfig(cluster: Cluster) {

        let connection;
        try {
            connection = this.sql.startTransaction();

            for (const folder of cluster.folders) {
                if (this.extraDebugging) {
                    console.debug('Database::updateClusterConfig:', folder);
                }

                const folderRow = this.sql.getFolder(folder.idString, connection);
                let folderId: number;

                // TODO: use label as path, but make sure unique among all folders
                // add special character, if two folders have same label
                // for now use string id
                folder.path = folder.idString;

                if (folderRow === null) {
                    console.debug('Database::updateClusterConfig new folder ' + folder.idString);
                    folderId = this.sql.addFolder(folder, connection).lastInsertRowid;
                }
                else {
                    folderId = folderRow.id;
                    if (!this.sql.isRowEqual(folder, folderRow)) {
                        console.debug('Database::updateClusterConfig updating folder ' + folder.idString);
                        this.sql.updateFolder(folder, folderRow.id, connection);
                    }
                }

                for (const device of folder.devices) {
                    const isSelf = this.sql.isArrayEqual(device.id, this.deviceId);
                    const deviceRow = this.sql.getDevice(folderId, device.id, connection);

                    // we don't want external name, updating internal name
                    if (isSelf) {
                        device.name = this.name;
                    }

                    if (deviceRow === null) {
                        console.debug('Database::updateClusterConfig new device ' + device.name);
                        this.sql.addDevice(device, folderId, isSelf, connection);
                    }
                    else {
                        if (!this.sql.isRowEqual(device, deviceRow)) {
                            let maxSequenceInternal = deviceRow.maxSequenceInternal;

                            // if the index_id has changed, we need to reset max sequence
                            if (!isSelf && !this.sql.isArrayEqual(device.indexId, deviceRow.indexId)) {
                                console.debug('Database::updateClusterConfig updating device, indexId has changed');
                                maxSequenceInternal = 0;
                            }

                            this.sql.updateDevice(device, deviceRow.id, folderId, maxSequenceInternal, connection);
                        }
                    }
                }
            }
            this.sql.commitTransaction(connection);
        }
        catch (err) {
            this.sql.rollbackTransaction(connection);

            console.error('Database::updateClusterConfig: failed to update cluster config');
            console.error(err);
        }

        // TODO: if any folder exists in db, but not in Cluster delete from db
    }

    private splitPath(path: string) : SplitPath {
        const splitPath : SplitPath = {
            folder: '',
            dir: '',
            file: ''
        };

        const parsedPath = parse(path);

        // special case for path with only folder in
        if (parsedPath.dir === parsedPath.root) {
            splitPath.dir = sep;
            splitPath.folder = parsedPath.base;
            return splitPath;
        }

        // remove root from dir
        parsedPath.dir = parsedPath.dir.substring(parsedPath.root.length);
        // split dir by separator
        const dirs = parsedPath.dir.split(sep);

        splitPath.folder = dirs.splice(0, 1)[0];

        // if ends in sep then no file
        if (path.endsWith(sep)) {
            splitPath.file = '';
            splitPath.dir = join(...dirs, parsedPath.base);
        }
        else {
            splitPath.file = parsedPath.base
            if (dirs.length) {
                splitPath.dir = join(...dirs);
            }
        }

        splitPath.dir = sep + splitPath.dir;
        return splitPath;
    }

    blocksToRequest(limit: number) : Block[] {
/*    	return this.all(`SELECT block.file_id, folder.id_string AS folder_id, directory.name || '/' || file.name AS name, block.size, block.offset, block.hash
            FROM block
            LEFT JOIN file
            ON block.file_id = file.id
            LEFT JOIN directory
            ON file.directory_id = directory.id
            LEFT JOIN folder
            ON directory.folder_id = folder.id
            WHERE (block.cached = 2 OR block.cached = 0) AND file.sync > ${SyncStatus.none}
            ORDER BY block.file_id
            LIMIT ?`, [limit]); */
            return [];
    }

    blocksToDelete(limit: number) : Block[] {
    /*    	return this.all(`SELECT block.file_id, folder.id_string AS folder_id, directory.name || '/' || file.name AS name, block.size, block.offset, block.hash
            FROM block
            LEFT JOIN file
            ON block.file_id = file.id
            LEFT JOIN directory
            ON file.directory_id = directory.id
            LEFT JOIN folder
            ON directory.folder_id = folder.id
            WHERE block.cached = 2 AND block.size = 0
            LIMIT ?`, [limit]); */
            return [];
    }

    updateBlock(blockRequest: BlockRequest) {
        this.sql.updateBlock(blockRequest.block, blockRequest.fileId, blockRequest.block.offset);
    }

    blocksToSatisfyRead(path: string, position: number, length: number) : BlockRequest[] {
        const splitPath = this.splitPath(path);

        const blockRows = this.sql.getBlocksOffset(
            splitPath.folder,
            splitPath.dir,
            splitPath.file,
            position,
            length
        );

        const blockRequests : BlockRequest[] = [];
        for (const blockRow of blockRows) {
            blockRequests.push({
            	id: 0,
                fileId: blockRow.fileId,
                folder: splitPath.folder,
                name: join(splitPath.dir, splitPath.file),
                block: {
                    size: blockRow.size,
                    offset: blockRow.offset,
                    hash: blockRow.hash,
                    cached: blockRow.cached,
                }
            });
        }

        return blockRequests;
    }

    updateSync(path: string, sync: SyncStatus) : boolean {
        console.debug('Database::updateSync: ', path, sync);

        if (path === '/') {
            return false;
        }

        let connection;
        let updated = false;

        try {
            let splitPath = this.splitPath(path);
            if (splitPath.folder === '') {
                throw('no folder id string in path ' + path);
            }

            connection = this.sql.startTransaction();

            // with no end separator path could be a file or folder
            if (!path.endsWith(sep)) {
                const fileRow = this.sql.getFileParentName(splitPath.folder, splitPath.dir, splitPath.file, connection);
                if (fileRow !== null) {
                    fileRow.sync = sync;
                    this.sql.updateFile(fileRow, fileRow.directoryId, fileRow.id, connection);
                    updated = true;
                }
            }

            // if it ends in a separator OR we couldn't find a matching file, try finding matching directory
            if (updated === false) {
                splitPath = this.splitPath(path + sep);
                const directoryRow = this.sql.getDirectoryFolderPath(splitPath.folder, splitPath.dir, connection);
                if (directoryRow === null) {
                    throw('no matching folder or file ' + path);
                }

                // TODO: recursive update of all child directories and files
            }


            this.sql.commitTransaction(connection);
            return updated;
        }
        catch (err) {
            this.sql.rollbackTransaction(connection);

            console.error('Database::updateSync: failed to update sync', path);
            console.error(err);
            return false;
        }
    }

    // dir MUST include folder root and start with '/'
    list(dir: string) : ListEntry[] {
        console.debug('Database::list: dir', dir);
        const list: ListEntry[] = [];

        // if root, send back folder list
        if (dir === '/') {
            const folderRows = this.sql.getFolders();
            for (const folderRow of folderRows) {
                list.push({
                    type: ListEntryType.directory,
                    name: folderRow.path,
                    size: 0,
                    permissions: 493,
                    modified: new Date(),
                    modifiedBy: 0
                });
            }
        }
        else {
            // this MUST be a folder path, so should end in '/'
            if (dir.charAt(dir.length-1) !== sep) {
                dir += sep;
            }

            const splitPath = this.splitPath(dir);
            if (splitPath.folder === '') {
                return list;
            }

            const parentDirectoryRow = this.sql.getDirectoryFolderPath(splitPath.folder, splitPath.dir);
            if (parentDirectoryRow === null || parentDirectoryRow.flags & FileFlags.deleted) {
                console.debug('Database:list: no directory found or deleted', dir);
                return list;
            }

            console.debug('Database::list: found parent directory', parentDirectoryRow);

            const directoryRows = this.sql.getDirectoriesParent(parentDirectoryRow.folderId, splitPath.dir);
            for (const directoryRow of directoryRows) {
                if (directoryRow.flags & FileFlags.deleted) {
                    continue;
                }

                list.push({
                    type: ListEntryType.directory,
                    name: directoryRow.name,
                    size: 0,
                    permissions: directoryRow.permissions,
                    modified: new Date(directoryRow.modifiedS * 1000),
                    modifiedBy: 0
                });
            }

            const fileRows = this.sql.getFilesParent(parentDirectoryRow.id);
            for (const fileRow of fileRows) {
                if (fileRow.flags & FileFlags.deleted) {
                    continue;
                }

                list.push({
                    type: ListEntryType.file,
                    name: fileRow.name,
                    size: fileRow.size,
                    permissions: fileRow.permissions,
                    modified: new Date(fileRow.modifiedS * 1000),
                    modifiedBy: 0
                });
            }
        }

        console.debug('Database::list: ', list);
        return list;
    }

    attributes(path: string) : ListEntry | null {
        console.debug('Database::attributes: path', path);
        if (path === '/') {
            // we don't have an entry for root, this is the directory above all folders
            return {
                type: ListEntryType.directory,
                name: '/',
                size: 0,
                permissions: 493,
                modified: new Date(),
                modifiedBy: 0
            }
        }
        else {
            // with no end separator path could be a file or folder
            // with end separator it can only be a directory
            let dirPath = this.splitPath(path + sep);
            if (dirPath.folder === '') {
                return null;
            }

            // if path doesn't end with separator, try for a file
            if (!path.endsWith(sep)) {
                let filePath = this.splitPath(path);
                const fileRow = this.sql.getFileParentName(filePath.folder, filePath.dir, filePath.file);
                if (fileRow !== null && !(fileRow.flags * FileFlags.deleted)) {
                    return {
                        type: ListEntryType.file,
                        name: fileRow.name,
                        size: fileRow.size,
                        permissions: fileRow.permissions,
                        modified: new Date(fileRow.modifiedS * 1000),
                        modifiedBy: 0
                    };
                }
            }

            // otherwise try for a directory
            const directoryRow = this.sql.getDirectoryFolderPath(dirPath.folder, dirPath.dir);
            if (directoryRow !== null && !(directoryRow.flags & FileFlags.deleted)) {
                return {
                    type: ListEntryType.directory,
                    name: directoryRow.name,
                    size: 0,
                    permissions: directoryRow.permissions,
                    modified: new Date(directoryRow.modifiedS * 1000),
                    modifiedBy: 0
                };
            }

            return null;
        }
    }
}
