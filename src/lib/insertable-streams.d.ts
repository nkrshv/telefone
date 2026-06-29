// Type augmentation for the WebRTC Encoded Transform APIs.
// Two flavours exist and neither is in the default TS DOM lib:
//   - Chrome/Edge: RTCRtpSender/Receiver.createEncodedStreams() (Insertable Streams)
//   - Safari/standard: RTCRtpScriptTransform + a worker `onrtctransform` handler

export interface RTCEncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
}

export interface InsertableStreamPair {
  readable: ReadableStream<RTCEncodedFrame>;
  writable: WritableStream<RTCEncodedFrame>;
}

declare global {
  // Standard (Safari) encoded-transform API.
  interface RTCRtpScriptTransformer {
    readable: ReadableStream<RTCEncodedFrame>;
    writable: WritableStream<RTCEncodedFrame>;
    readonly options: unknown;
  }
  interface RTCTransformEvent extends Event {
    readonly transformer: RTCRtpScriptTransformer;
  }
  class RTCRtpScriptTransform {
    constructor(worker: Worker, options?: unknown, transfer?: Transferable[]);
  }

  interface RTCRtpSender {
    createEncodedStreams?(): InsertableStreamPair;
    transform?: RTCRtpScriptTransform;
  }
  interface RTCRtpReceiver {
    createEncodedStreams?(): InsertableStreamPair;
    transform?: RTCRtpScriptTransform;
  }
  interface RTCConfiguration {
    encodedInsertableStreams?: boolean;
  }
}
