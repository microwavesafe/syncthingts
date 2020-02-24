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

import * as https from 'https';

export interface DiscoverReply {
    seen: string,
    addresses: string[];
};

export function discover(url: string) : Promise<DiscoverReply> {
    // TODO: test authentication of discovery server
    // not sure this is possible with https.get
    return new Promise ((resolve, reject) => {
        https.get(
            url,
            // discovery servers have self signed certificates
            // we are only getting addresses, where the id of the
            // connected peer will be authenticated anyway
            {  rejectUnauthorized: false },
            (res) => {
            const { statusCode } = res;
            const contentType = res.headers['content-type'];

            if (statusCode !== 200 || !/^application\/json/.test(contentType)) {
                // Consume response data to free up memory
                console.error('::discover: failed to get request', url, statusCode);
                res.resume();
                reject();
            }

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => {
                rawData += chunk;
            });
            res.on('end', () => {
                try {
                    const discoverReply = JSON.parse(rawData);
                    console.debug('::discover: reply', discoverReply);

                    if (discoverReply.hasOwnProperty('seen')
                    && discoverReply.hasOwnProperty('addresses')) {
                        resolve(discoverReply);
                    }
                    else {
                        reject();
                    }
                }
                catch (e) {
                    console.error('::discover: failed to parse JSON', e.message);
                    reject();
                }
            });
        }).on('error', (e) => {
            console.error('::discover: failed to make request', e);
            reject();
        });
    });
}
