// Worker for Safari's standard WebRTC Encoded Transform API.
// Chrome uses RTCRtpSender.createEncodedStreams() on the main thread; Safari
// instead requires an RTCRtpScriptTransform whose work runs here, in a worker.
// The on-the-wire format is identical (see crypto.ts), so a Chrome peer and a
// Safari peer interoperate with full AES-256-GCM end-to-end encryption.
import { createDecryptTransform, createEncryptTransform } from './crypto';

interface TransformOptions {
  operation: 'encrypt' | 'decrypt';
  key: CryptoKey;
}

interface WorkerScope {
  onrtctransform: ((event: RTCTransformEvent) => void) | null;
}

(self as unknown as WorkerScope).onrtctransform = (event: RTCTransformEvent) => {
  const { readable, writable, options } = event.transformer;
  const { operation, key } = options as TransformOptions;
  const transform =
    operation === 'encrypt'
      ? createEncryptTransform(key)
      : createDecryptTransform(key);
  void readable.pipeThrough(transform).pipeTo(writable);
};
