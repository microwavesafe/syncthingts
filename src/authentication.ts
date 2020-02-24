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

import { TLSSocket } from 'tls';
import { pem, md, pki, util } from 'node-forge';

import base32Encode from 'base32-encode';
import base32Decode from 'base32-decode';
import { randomBytes } from 'crypto';

export interface DeviceId {
	asBytes: Uint8Array;
	asString: string;
	valid: boolean;
};

export default class Authentication {

    private id_ = new Uint8Array(32);
    private idString_: string;

    private static calculateCheckDigit(group: String) : string {
        // Doesn't follow the actual Luhn algorithm,
        // see https://forum.syncthing.net/t/v0-9-0-new-node-id-format/478/6 for more.

        let sum = 0
        let factor = 1
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const alphabetSize = alphabet.length;

        for (let character of group) {
            const codePoint = alphabet.indexOf(character);
            if (codePoint === -1) {
                throw('Authentication::calculateCheckDigit: invalid check digit calculated');
            }

            let addend = factor * codePoint;
            sum += Math.floor((addend / alphabetSize) + (addend % alphabetSize));
            factor = factor === 1 ? 2 : 1
        }

        const checkCodePoint = (alphabetSize - (sum % alphabetSize));
        return alphabet[checkCodePoint];
    }

    private static addCheckDigits(deviceId: string) : string {
        // split device ID into groups of 13 digits
        if (deviceId.length !== 52) {
        	throw('Authentication::addCheckDigits: incorrect device ID length');
        }

        let deviceIdChecked = '';

        for (let i=0; i<4; i++) {
            const group = deviceId.substr(i*13, 13);
            const checkDigit = this.calculateCheckDigit(group);
            deviceIdChecked += group;
            deviceIdChecked += checkDigit;
        }

        return deviceIdChecked;
    }

    private static removeCheckDigits(deviceIdChecked: string) : string {
        if (deviceIdChecked.length !== 56) {
        	throw('Authentication::removeCheckDigits: incorrect device ID length ' + deviceIdChecked.length);
        }

        let deviceId = '';

        for (let i=0; i<4; i++) {
            const index = i*14;
            const group = deviceIdChecked.substr(index, 13);
            const checkDigit = deviceIdChecked[index + 13];
            const calculatedCheckDigit = this.calculateCheckDigit(group);

            if (checkDigit !== calculatedCheckDigit) {
            	throw('Authentication::removeCheckDigits: check digit incorrect at ' + index);
            }

            deviceId += group;
        }

        return deviceId;
    }

    // pass in certificate return value of readFileSync
    // TODO: work out correct type
    static fromCertificate(certificate: any) : DeviceId {
        // decode the certificate
        // device ID is SHA-256 of certifcate data
        // encoded as base32 with check digits added
        let certPem = pem.decode(certificate);

        if (!Array.isArray(certPem) || certPem.length === 0 || !certPem[0].hasOwnProperty('body')) {
            console.error('Authentication::fromCertificate: can not decode certificate');
            return {
            	asBytes: new Uint8Array(0),
                asString: '',
                valid: false,
            };
        }

        try {
            let hash = md.sha256.create();
            hash.update(certPem[0].body);
            let digest = hash.digest();

            const asBytes = new Uint8Array(32);
            // I can't work out what the buffer format is for forge
            // ended up manually copying out the data to get the base32 encoders working
            for (let i=0; i<32; i++) {
                asBytes[i] = digest.at(i);
            }

            const asString = this.addCheckDigits(base32Encode(asBytes, 'RFC4648', { padding: false }));

            return {
            	asBytes,
                asString,
                valid: true,
            };
        }
        catch (e) {
        	console.error(e);

            return {
            	asBytes: new Uint8Array(0),
                asString: '',
                valid: false,
            };
        }
    }

    static fromSocket(socket: TLSSocket, peer: boolean = true) : DeviceId {
        let certHashString;
        try {
	        if (peer) {
	            // @ts-ignore - types aren't correct fingerprint256 exists
	            certHashString = socket.getPeerCertificate().fingerprint256.replace(/:/g, '');
	        }
	        else {
	            // @ts-ignore - types aren't correct getCertificate exists
	            certHashString = socket.getCertificate().fingerprint256.replace(/:/g, '');
	        }

	        const asBytes = Uint8Array.from(Buffer.from(certHashString, 'hex'));
	        return {
	            asBytes,
	            asString: this.addCheckDigits(base32Encode(asBytes, 'RFC4648', { padding: false })),
	            valid: true,
	        };
	    }
	    catch (e) {
		    console.error(e);
            return {
            	asBytes: new Uint8Array(0),
                asString: '',
                valid: false,
            };
        }
    }

    static fromString(deviceId: string) : DeviceId {
        // get rid of any hyphens
        try {
             deviceId = deviceId.replace(/-/g, '');
            return {
                asString: deviceId,
                asBytes: new Uint8Array(base32Decode(this.removeCheckDigits(deviceId), 'RFC4648')),
                valid: true,
            };
        }
        catch (e) {
		    console.error(e);
            return {
            	asBytes: new Uint8Array(0),
                asString: '',
                valid: false,
            };
        }
    }

    static generateCertificate(path: string) {
        // TODO: node-forge doesn't support signing edcsa certificates
        // use node Crypto module instead
        // test that path is a directory

        // use node-forge to generate certificate / key pair
        const keys = pki.rsa.generateKeyPair(2048);
        const cert = pki.createCertificate();

        cert.publicKey = keys.publicKey;
        cert.serialNumber = util.bytesToHex(randomBytes(20));
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 30);

        var attrs = [
            {name:'commonName',value:'syncthing'},
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);

        cert.sign(keys.privateKey, md.sha256.create());

        const pem_pkey = pki.publicKeyToPem(keys.publicKey);
        const pem_cert = pki.certificateToPem(cert);

        console.log(pem_pkey);
        console.log(pem_cert);
    }
}
