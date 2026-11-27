'use strict';

/**
 * `fabric:` frame helpers. They live on `Message` (`types/message`).
 * @param {Function} Message
 * @returns {Object}
 */
function messageFabricUri (Message) {
  return {
    FABRIC_URI_SCHEME: Message.FABRIC_URI_SCHEME,
    encodeFabricUri: Message.encodeFabricUri,
    decodeFabricUri: Message.decodeFabricUri,
    parseFabricUriBytes: Message.parseFabricUriBytes,
    isFabricUri: Message.isFabricUri
  };
}

module.exports = messageFabricUri;
