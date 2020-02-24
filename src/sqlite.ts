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

import BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'crypto';

import { Device, Folder, Directory, File, Block } from './constants'

export interface DeviceRow {
    id: Uint8Array;
    folderId: number,
    name: string;
    addresses: string;
    maxSequence: number;
    maxSequenceInternal: number;
    indexId: Uint8Array;
};

export interface FolderRow {
    idString: string;
    label: string;
    path: string;
    flags: number;
    id: number;
};

export interface DirectoryRow {
    id: number;
    folderId: number;
    name: string;
    permissions: number;
    modifiedS: number;
    modifiedNs: number;
    modifiedBy: Uint8Array;
    flags: number;
    sequence: number;
    version: string;
    sync: number;
};

export interface FileRow {
    id: number;
    name: string;
    directoryId: number;
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
};

export interface BlockRow {
    fileId: number;
    offset: number;
    size: number;
    hash: Uint8Array;
    cached: number;
};

// TODO: create indexes to improve performance, especially on block table
// convert all Integer to number on size and offset, although this is a limitation
// it still provides a huge max file size (2^53)

interface EditData {
    columns: string[];
    values: any[];
}

const SCHEMA_VERSION = 1;
// setting minimum connections prevents connections in lower array index from auto closing
const MIN_CONNECTIONS = 5;
const MAX_CONNECTIONS = 100;
const CONNECTION_TIMEOUT = 5000;
const AUTO_CLOSE = 600000


export default class Sqlite {
    private databasePath: string;
    private connections: any[];
    private extraDebugging: boolean;

    constructor(path: string, extraDebugging = false) {
        this.databasePath = path;
        this.connections = [];
        this.extraDebugging = extraDebugging;

        let version;

        try {
            version = this.get('SELECT version from schema');
        }
        catch (err) {
            if (err.code === 'SQLITE_ERROR') {
                console.debug('Sqlite:: creating schema');
                try {
                    version = this.createSchema();
                } catch (err) {
                    console.error('Sqlite:: can not create schema');
                    throw (err);
                }
            }
            else {
                console.error('Sqlite:: could not connect to database', err.code);
                throw(err);
            }
        }

        console.debug('Sqlite:: schema version ', version);
        // if we need to update schema do it here
        if (version < SCHEMA_VERSION) {

        }
    }

    destructor() {
        for (const db of this.connections) {
            if (db && db.open) {
                db.close();
            }
        }
    }

    private createSchema() {
        this.run(`
            CREATE TABLE schema (
                version integer
            )`
        );

        this.run(`
            CREATE TABLE folder (
                id integer primary key autoincrement,
                idString text UNIQUE NOT NULL,
                label text,
                path text,
                flags integer
            )`
        );

        this.run(`
            CREATE TABLE device (
                id blob NOT NULL,
                folderId integer NOT NULL,
                name text,
                addresses text,
                maxSequence integer,
                maxSequenceInternal integer,
                indexId blob,
                UNIQUE (id, folderId)
            )`
        );

        this.run(`
            CREATE TABLE directory (
                id integer primary key autoincrement,
                folderId integer NOT NULL,
                name text NOT NULL,
                permissions integer,
                modifiedS integer,
                modifiedNs integer,
                modifiedBy blob,
                flags integer,
                sequence integer,
                version text,
                sync integer,
                UNIQUE (folderId, name)
            )`
        );

        this.run(`
            CREATE TABLE file (
                id integer primary key autoincrement,
                name text NOT NULL,
                directoryId integer NOT NULL,
                size integer,
                permissions integer,
                modifiedS integer,
                modifiedNs integer,
                modifiedBy blob,
                flags integer,
                sequence integer,
                blockSize integer,
                version text,
                symlinkTarget text,
                sync integer,
                UNIQUE (directoryId, name)
            )`
        );

        // cached 0 - none, 1 - cached, 2 - cache stale
        this.run(`
            CREATE TABLE block (
                fileId integer NOT NULL,
                offset integer NOT NULL,
                size integer,
                hash blob,
                cached integer,
                UNIQUE (fileId, offset)
            )`
        );

        // Insert schema version
        this.run(`
            INSERT INTO schema
            (version)
            VALUES
            (?)`,
            [SCHEMA_VERSION]
        );

        return SCHEMA_VERSION;
    }

    private autoClose(connection: any) {
        // do NOT auto close connection for minimum number of connections
        if (connection.index < MIN_CONNECTIONS) {
            return;
        }

        if (connection.autoClose) {
            clearTimeout(connection.autoClose);
        }

        connection.autoClose = setTimeout(function() {
            console.debug('Sqlite:: auto closing database ' + connection.index);
            connection.close();
        }, AUTO_CLOSE);
    }

    private sql(type: string, sql: string, params = [], connection? : any) {
        let free = false;

        // convert boolean to number
        for (let i = 0; i < params.length; i++) {
            if (params[i] === true) {
                params[i] = 1;
            }
            else if (params[i] === false) {
                params[i] = 0;
            }
        }

        try {
            if (!connection) {
                connection = this.db();
                free = true;
            }

            if (type !== 'exec') {
                const result = connection.prepare(sql)[type](params);
                return result;
            }
            else {
                connection.exec(sql);
            }
        }
        catch (err) {
            throw(err);
        }
        finally {
            if (free) {
                connection.free();
            }
        }
    }

    private instanceOfEditData(object: any) {
        // WARNING: this will fail in tables with 'columns' and 'values' columns
        return (Array.isArray(object.columns) && Array.isArray(object.values));
    }

    private valuesSql(fields: number): string {
        return '?' + ', ?'.repeat(fields - 1);
    }

    private setSql(columns: string[]): string {
        let substitution = '';
        for (let i=0; i<columns.length; i++) {
            substitution += columns[i] + ' = ?';
            if (i < (columns.length - 1)) {
                substitution += ', ';
            }
        }
        return substitution;
    }

    private whereEqualSql(columns: string[]): string {
        let substitution = '';
        for (let i=0; i<columns.length; i++) {
            substitution += columns[i] + ' = ?';
            if (i < (columns.length - 1)) {
                substitution += ' AND ';
            }
        }
        return substitution;
    }

    private splitData(data: object): EditData {
        // split the row object into column names and value arrays
        let columns: string[] = Object.keys(data);
        let values: any[] = [];

        columns.forEach((column) => {
            if (data[column] === '') {
                values.push(null);
            }
            else {
                values.push(data[column]);
            }
        });

        return {
            columns: columns,
            values: values,
        }
    }

    db(): any {
        for (const connection of this.connections) {
            if (connection.open && connection.isFree) {
                connection.isFree = false;

                // restart timeout
                this.autoClose(connection);
                if (this.extraDebugging) {
                    console.debug('Sqlite::db: got open free connection ' + connection.index);
                }
                return connection;
            }
        }

        if (this.connections.length < MAX_CONNECTIONS) {
            const connection = new BetterSqlite3(this.databasePath, {
                timeout: CONNECTION_TIMEOUT,
                // debug all SQL if extra debugging set
                verbose: this.extraDebugging ? console.debug : null,
            });

            connection.isFree = false;
            connection.index = this.connections.length;

            connection.free = function() {
                if (connection.open && connection.inTransaction) {
                    connection.exec("rollback");
                }
                connection.isFree = true;
            };

            // add to connection list
            this.connections.push(connection);
            // auto close to free up resources, allows us to use large pool
            this.autoClose(connection);
            console.debug('Sqlite::db: connected ' + this.databasePath + ' connection ' + connection.index);
            return connection;
        }

        // fail if no connections, we don't want to wait here
        throw('Sqlite::no available connections, increase MAX_CONNECTIONS');
    }

    private get(sql: string, params = [], connection? :any) {
        return this.sql('get', sql, params, connection);
    }

    all(sql: string, params = [], connection? :any) {
        return this.sql('all', sql, params, connection);
    }

    run(sql: string, params = [], connection? :any) {
        return this.sql('run', sql, params, connection);
    }

    exec(sql: string, connection? :any) {
        this.sql('exec', sql, [], connection);
    }

    private insert(table: string, data: EditData | any, connection? :any) {
        // determine if we have split data
        if (!this.instanceOfEditData(data)) {
            data = this.splitData(data);
        }

        return this.run(`
            INSERT INTO ${table}
            (${data.columns.join()})
            VALUES(${this.valuesSql(data.columns.length)})`,
            data.values, connection
        );
    }

    private update(table: string, data: EditData | any, where: EditData | any, connection? :any) {
        if (!this.instanceOfEditData(data)) {
            data = this.splitData(data);
        }

        if (!this.instanceOfEditData(where)) {
            where = this.splitData(where);
        }

        return this.run(`
            UPDATE ${table}
            SET ${this.setSql(data.columns)}
            WHERE ${this.whereEqualSql(where.columns)}`,
            [...data.values, ...where.values], connection
        );
    }

    private delete(table: string, where: EditData | any, connection? :any) {
        if (!this.instanceOfEditData(where)) {
            where = this.splitData(where);
        }

        return this.run(`
            DELETE FROM ${table}
            WHERE ${this.whereEqualSql(where.columns)}`,
            [...where.values], connection
        );
    }

    isArrayEqual(a: Uint8Array, b:Uint8Array): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    isRowEqual (data: any, row: any, ignore?: string[]): boolean {
        // for all properties in data, check that row is equal
        // this ignores order and ignores any property that doesn't exist in other object
        let keys: string[] = Object.keys(data);

        for (const key of keys) {

            if (!row.hasOwnProperty(key)) {
                continue;
            }

            if (ignore && ignore.includes(key)) {
                continue;
            }

            // empty column returns null, we can do a quick check for equality on different types
            if (row[key] === null) {
                if (typeof data[key] === 'string' && data[key] !== '') {
                    return false;
                }
            }

            // need to do some conversions
            else if (typeof data[key] === 'boolean' && typeof row[key] === 'number') {
                const number = data[key] ? 1 : 0;
                if (number !== row[key]) {
                    return false;
                }
            }

            else if (typeof data[key] != typeof row[key]) {
                console.debug('Sqlite::isRowEqual: different types', key, typeof data[key], typeof row[key]);
                console.debug(data[key], row[key]);
                return false;
            }

            else if (data[key] instanceof Uint8Array) {
                if (!this.isArrayEqual(data[key], row[key])) {
                    console.debug('Sqlite::isRowEqual: different array data', key);
                    return false;
                }
            }

            else if (data[key] !== row[key]) {
                console.debug('Sqlite::isRowEqual: different value', key);
                return false;
            }
        }
        return true;
    }

    startTransaction() {
        let connection = this.db();
        this.exec('BEGIN EXCLUSIVE', connection);
        return connection;
    }

    commitTransaction(connection: any) {
        this.exec('COMMIT', connection);

        if (connection) {
            connection.free();
        }
    }

    rollbackTransaction(connection: any) {
        if (connection) {
            if (connection.inTransaction) {
                this.exec('ROLLBACK', connection);
            }
            connection.free();
        }
    }

    updateSequence(deviceId: Uint8Array, folderId: number, sequence: number, connection?: any) {
        const data = {
            maxSequenceInternal: sequence,
            folderId: folderId,
        };

        return this.update('device', data, {id: deviceId, folderId: folderId}, connection);
    }

    getDevice(folderId: number, id: Uint8Array, connection? :any) : DeviceRow {
        const deviceRow = this.get(`SELECT *
            FROM device
            WHERE id = ?
            AND folderId = ?`,
            [id, folderId],
            connection
        );

        if (deviceRow === undefined) {
            return null;
        }

        return deviceRow;
    }

    getDevices(folderId: number, connection? :any) : DeviceRow[] {
        return this.all(`
            SELECT *
            FROM device
            WHERE folderId = ?`,
            [folderId],
            connection
        );
    }

    addDevice(device: Device, folderId: number, isSelf: boolean, connection? :any) {
        const data = {
            id: device.id,
            maxSequenceInternal: 0,
            folderId: folderId,
            name: device.name,
            addresses: device.addresses,
            maxSequence: device.maxSequence,
            indexId: device.indexId,
        };

        // if this is us we need to generate a new index id
        if (isSelf) {
            data.indexId = randomBytes(8);
        }

        return this.insert('device', data, connection);
    }

    updateDevice(device: Device, id: Uint8Array, folderId: number, maxSequenceInternal: number, connection? :any) {
        const data = {
            maxSequenceInternal: maxSequenceInternal,
            name: device.name,
            addresses: device.addresses,
            maxSequence: device.maxSequence,
            indexId: device.indexId,
        };

        return this.update('device', data, {id: id, folderId: folderId}, connection);
    }

    getFolder(idString: string, connection? :any) : FolderRow {
        const folderRow = this.get(`
            SELECT *
            FROM folder
            WHERE idString = ?`,
            [idString],
            connection
        );

        if (folderRow === undefined) {
            return null;
        }

        return folderRow;
    }

    getFolders(connection? :any) : FolderRow[] {
        return this.all(`
            SELECT *
            FROM folder`,
            [],
            connection
        );
    }

    addFolder(folder: Folder, connection?: any) {
        const data = {
            idString: folder.idString,
            label: folder.label,
            path: folder.path,
            flags: folder.flags,
        };

        return this.insert('folder', data, connection);
    }

    updateFolder(folder: Folder | FolderRow, id: number, connection?: any) {
        const data = {
            idString: folder.idString,
            label: folder.label,
            path: folder.path,
            flags: folder.flags,
        };

        return this.update('folder', data, {id: id}, connection);
    }

    getDirectoriesParent(folderId: number, parentName: string, connection?: any) : DirectoryRow[] {
        return this.all(
            `SELECT id, folderId, replace(name, ?, "") AS name, permissions, modifiedS, modifiedNs, modifiedBy, flags, sequence, version, sync
            FROM directory
            WHERE folderId = ? AND name LIKE ? || "_%" AND name NOT LIKE ? || "%/%"`,
            [parentName, folderId, parentName, parentName],
            connection
        );
    }

    getDirectory(folderId: number, name: string, connection?: any) : DirectoryRow {
        const directoryRow = this.get(
            `SELECT * FROM directory
            WHERE name = ?
            AND folderId = ?`,
            [name, folderId],
            connection
        );

        if (directoryRow === undefined) {
            return null;
        }
        return directoryRow;
    }

    getDirectoryFolderPath(folderPath: string, name: string, connection?: any) : DirectoryRow {
        const directoryRow = this.get(
            `SELECT directory.*
            FROM directory
            LEFT JOIN folder
            ON directory.folderId = folder.id
            WHERE directory.name = ? and folder.path = ?`,
            [name, folderPath],
            connection
        );

        if (directoryRow === undefined) {
            return null;
        }
        return directoryRow;
    }

    addDirectory(directory: Directory, folderId: number, connection?: any) {
        const data = {
            name: directory.name,
            permissions: directory.permissions,
            modifiedS: directory.modifiedS,
            modifiedNs: directory.modifiedNs,
            modifiedBy: directory.modifiedBy,
            sequence: directory.sequence,
            version: directory.version,
            flags: directory.flags,
            sync: directory.sync,
            folderId: folderId,
        };

        return this.insert('directory', data, connection);
    }

    updateDirectory(directory: Directory | DirectoryRow, folderId: number, id: number, connection?: any) {
        const data = {
            name: directory.name,
            permissions: directory.permissions,
            modifiedS: directory.modifiedS,
            modifiedNs: directory.modifiedNs,
            modifiedBy: directory.modifiedBy,
            sequence: directory.sequence,
            version: directory.version,
            flags: directory.flags,
            sync: directory.sync,
            folderId: folderId,
        };

        return this.update('directory', data, {id: id}, connection);
    }

    getFileParentName(folderPath: string, directoryName: string, name: string, connection?: any) : FileRow {
        const fileRow = this.get(`
            SELECT file.*
            FROM file
            LEFT JOIN directory
            ON file.directoryId = directory.id
            LEFT JOIN folder
            ON directory.folderId = folder.id
            WHERE file.name = ? AND directory.name = ? AND folder.path = ?`,
            [name, directoryName, folderPath],
            connection
        );

        if (fileRow === undefined) {
            return null;
        }
        return fileRow;
    }

    getFilesParent(directoryId: number, connection?: any) : FileRow[] {
        return this.all(
            `SELECT *
            FROM file
            WHERE directoryId = ?`,
            [directoryId],
            connection
        );
    }

    getFile(directoryId: number, name: string, connection?: any) : FileRow {
        const fileRow = this.get(
            `SELECT * FROM file
            WHERE name = ?
            AND directoryId = ?`,
            [name, directoryId],
            connection);

        if (fileRow === undefined) {
            return null;
        }
        return fileRow;
    }

    addFile(file: File, directoryId: number, connection?: any) {
        const data = {
            name: file.name,
            size: file.size,
            permissions: file.permissions,
            modifiedS: file.modifiedS,
            modifiedNs: file.modifiedNs,
            modifiedBy: file.modifiedBy,
            flags: file.flags,
            sequence: file.sequence,
            blockSize: file.blockSize,
            version: file.version,
            symlinkTarget: file.symlinkTarget,
            sync: file.sync,
            directoryId: directoryId,
        };

        return this.insert('file', data, connection);
    }

    updateFile(file: File | FileRow, directoryId: number, id: number, connection?: any) {
        const data = {
            name: file.name,
            size: file.size,
            permissions: file.permissions,
            modifiedS: file.modifiedS,
            modifiedNs: file.modifiedNs,
            modifiedBy: file.modifiedBy,
            flags: file.flags,
            sequence: file.sequence,
            blockSize: file.blockSize,
            version: file.version,
            symlinkTarget: file.symlinkTarget,
            sync: file.sync,
            directoryId: directoryId,
        };

        return this.update('file', data, {id: id}, connection);
    }

    getBlock(fileId: number, offset: number, connection?: any) : BlockRow {
        const blockRow = this.get(`
            SELECT *
            FROM block
            WHERE fileId = ?
            AND offset = ?`,
            [fileId, offset],
            connection
        );

        if (blockRow === undefined) {
            return null;
        }
        return blockRow;
    }

    getBlocks(fileId: number, connection? :any): BlockRow[] {
        return this.all(`
            SELECT *
            FROM block
            WHERE fileId = ?
            ORDER BY offset`,
            [fileId],
            connection
        );
    }

    addBlock(block: Block, fileId: number, connection?: any) {
        const data = {
            offset: block.offset,
            size: block.size,
            hash: block.hash,
            cached: block.cached,
            fileId: fileId
        };

        return this.insert('block', data, connection);
    }

    updateBlock(block: Block | BlockRow, fileId: number, offset: number, connection?: any) {
        const data = {
            offset: block.offset,
            size: block.size,
            hash: block.hash,
            cached: block.cached,
            fileId: fileId
        };

        return this.update('block', data, {fileId: fileId, offset: offset}, connection);
    }

    deleteBlock(fileId: number, offset: number, connection?: any) {
        return this.delete('block', {fileId: fileId, offset: offset}, connection);
    }

    getBlocksOffset(folderPath: string, directoryName: string, fileName: string, position: number, length: number, connection? :any) : BlockRow[] {
        return this.all(
            `SELECT block.*
	        FROM block
	        LEFT JOIN file
            ON block.fileId = file.id
            LEFT JOIN directory
            ON file.directoryId = directory.id
            LEFT JOIN folder
            ON directory.folderId = folder.id
	        WHERE
                folder.path = ?
                AND directory.name = ?
                AND file.name = ?
                AND block.offset < ?
                AND block.offset + block.size > ?
            ORDER BY block.offset`,
            [folderPath, directoryName, fileName, position + length, position],
            connection
        );
    }
}
