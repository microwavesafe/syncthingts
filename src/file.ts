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

import * as fs from 'fs-extra';
import { join, dirname } from 'path';
import * as crypto from 'crypto';

/*
 * By storing the blocks individually we can save cache space if only some blocks
 * of a large file are required.
 *
 * use this to watch files https://github.com/paulmillr/chokidar
 */

export default class File {

    static path(cachePath: string, folder: string, fileId: number, offset: number) {
        return join(cachePath, folder, fileId.toString(), offset.toString());
    }

    static async writeBlock(path: string, bytes: Uint8Array) {
        let fd = 0;
        try {
            await fs.ensureDir(dirname(path));
            // open for writing (truncate existing)
            fd = await fs.open(path, 'w');
            // TODO: should we be checking bytesWritten?
            await fs.write(fd, bytes, 0, bytes.length, 0);
            console.debug('File::writeBlock: wrote: ' + bytes.length + ' to ' + path);
        }
        finally {
            if (fd > 0) {
                fs.closeSync(fd);
            }
        }
    }

    static async readBlock(path: string, size: number, hash: Uint8Array) : Promise<Uint8Array> {
        let fd = 0;

        try {
            // open for reading
            fd = await fs.open(path, 'r');
            const buffer = new Uint8Array(size);
            const { bytesRead, temp } = await fs.read(fd, buffer, 0, size, 0);
            console.debug('File::readBlock: read: ' + bytesRead + ' from ' + path);

            if (bytesRead > 0) {
		        const fileHash = crypto.createHash('sha256').update(buffer).digest();
		        if (!fileHash.equals(hash)) {
			        console.debug('File::readBlock: failed hash verification ' + path);
			        return new Uint8Array(0);
			    }
	        }
			return buffer.subarray(0, bytesRead);
        }
        finally {
            if (fd > 0) {
                fs.closeSync(fd);
            }
        }

        return new Uint8Array(0);
    }
}
