# Syncthing TS

!!WARINING!! this is currently pre-alpha, it currently only supports reading files, so should be fairly safe but you are responsible for using it. This is NOT an official client and is not endorsed or audited by the Syncthing team.

This project is a library that provides the core functionality of a client using the Syncthing protocol.

This library has made major simplifications by only taking on the role of client and not joining the group as a peer. Therefore it accepts no incoming connections and will only connect to a single peer (in this instance acting like a server to this client).

Syncthing https://syncthing.net/ is reliable and fast and a good way of synchronising files between computers. You will need at least one instance of Syncthing up and running for this client library to communicate with.

The library is written in TypeScript and is intended to be installed using NPM.

## Aims

I could not find a sync client that allowed me to easily work in the different ways I want to work. Some folders I want to keep synchronised between computers, some folders only browse and open files and some folders I want to push to, much like git or other version control. The aim of this code is to allow any mix of operation on folders, sub folders and files. Giving the user the freedom to choose how the file syncing is handled.

## Getting Started

TODO:

## API

TODO:

## Building

To build the repository for release run

`$ npm run build`

## License

This project is licensed under the GPL 3.0 or later [LICENSE](LICENSE) file for details
