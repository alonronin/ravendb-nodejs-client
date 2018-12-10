import { IDisposable } from "../../Types/Contracts";
import { DocumentType } from "../DocumentAbstractions";
import { getLogger } from "../../Utility/LogUtil";
import { DocumentStore } from "../DocumentStore";
import { SubscriptionWorkerOptions } from "./SubscriptionWorkerOptions";
import { SubscriptionBatch } from "./SubscriptionBatch";
import { GetTcpInfoCommand, RavenErrorType, RequestExecutor, ServerNode } from "../..";
import { Socket } from "net";
import { StringUtil } from "../../Utility/StringUtil";
import { getError, throwError } from "../../Exceptions";
import { TcpUtils } from "../../Utility/TcpUtils";
import * as stream from "readable-stream";
import { TcpNegotiateParameters } from "../../ServerWide/Tcp/TcpNegotiateParameters";
import {
    SUBSCRIPTION_TCP_VERSION,
    SupportedFeatures,
    TcpConnectionHeaderMessage
} from "../../ServerWide/Tcp/TcpConnectionHeaderMessage";
import { OUT_OF_RANGE_STATUS, TcpNegotiation } from "../../ServerWide/Tcp/TcpNegotiation";
import { TcpConnectionHeaderResponse } from "../../ServerWide/Tcp/TcpConnectionHeaderResponse";
import { EventEmitter } from "events";
import { TimeUtil } from "../../Utility/TimeUtil";
import { ObjectUtil } from "../../Utility/ObjectUtil";
import { SubscriptionConnectionServerMessage } from "./SubscriptionConnectionServerMessage";
import { SubscriptionConnectionClientMessage } from "./SubscriptionConnectionClientMessage";
import { EmptyCallback } from "../../Types/Callbacks";
import { delay } from "../../Utility/PromiseUtil";
import * as Parser from "stream-json/Parser";
import * as StreamValues from "stream-json/streamers/StreamValues";
import { TransformKeysJsonStream } from "../../Mapping/Json/Streams/TransformKeysJsonStream";
import { getTransformJsonKeysProfile } from "../../Mapping/Json/Streams/TransformJsonKeysProfiles";

interface SubscriptionResponseParsedItem { 
    key: number; 
    value: SubscriptionConnectionServerMessage; 
}

type EventTypes = "afterAcknowledgment" | "connectionRetry" | "batch" | "error" | "end";

export class SubscriptionWorker<T extends object> implements IDisposable {

    private readonly _documentType: DocumentType<T>;
    private readonly _revisions: boolean;
    private readonly _logger = getLogger({ module: "SubscriptionWorker" });
    private readonly _store: DocumentStore;
    private readonly _dbName: string;
    private _processingCancelled = false;
    private readonly _options: SubscriptionWorkerOptions<T>;
    private _tcpClient: Socket;
    private _parser: stream.Transform;
    private _disposed: boolean = false;
    private _subscriptionTask: Promise<void>;
    private _emitter = new EventEmitter();

    public constructor(options: SubscriptionWorkerOptions<T>,
                       withRevisions: boolean, documentStore: DocumentStore, dbName: string) {
        this._documentType = options.documentType;
        this._options = Object.assign({
            strategy: "OpenIfFree",
            maxDocsPerBatch: 4096,
            timeToWaitBeforeConnectionRetry: 5 * 1000,
            maxErroneousPeriod: 5 * 60 * 1000
        }, options);
        this._revisions = withRevisions;

        if (StringUtil.isNullOrEmpty(options.subscriptionName)) {
            throwError("InvalidArgumentException", "SubscriptionConnectionOptions must specify the subscriptionName");
        }

        this._store = documentStore;
        this._dbName = dbName || documentStore.database;
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
        this._processingCancelled = true;

        this._closeTcpClient(); // we disconnect immediately
        if (this._parser) {
            this._parser.end();
        }
    }

    private _redirectNode: ServerNode;
    private _subscriptionLocalRequestExecutor: RequestExecutor;

    public get currentNodeTag() {
        return this._redirectNode ? this._redirectNode.clusterTag : null;
    }

    public get subscriptionName() {
        return this._options ? this._options.subscriptionName : null;
    }

    private async _connectToServer(): Promise<Socket> {
        const command = new GetTcpInfoCommand("Subscription/" + this._dbName, this._dbName);

        const requestExecutor = this._store.getRequestExecutor(this._dbName);

        if (this._redirectNode) {
            try {
                await requestExecutor.execute(command, null, {
                    chosenNode: this._redirectNode,
                    nodeIndex: null,
                    shouldRetry: false
                });
            } catch (e) {
                // if we failed to talk to a node, we'll forget about it and let the topology to
                // redirect us to the current node

                this._redirectNode = null;

                throw e;
            }
        } else {
            await requestExecutor.execute(command);
        }

        this._tcpClient =
            await TcpUtils.connect(command.result.url, command.result.certificate, this._store.authOptions);

        this._ensureParser();

        const databaseName = this._dbName || this._store.database;

        const parameters = {
            database: databaseName,
            operation: "Subscription",
            version: SUBSCRIPTION_TCP_VERSION,
            readResponseAndGetVersionCallback: url => this._readServerResponseAndGetVersion(url),
            destinationNodeTag: this.currentNodeTag,
            destinationUrl: command.result.url
        } as TcpNegotiateParameters;

        this._supportedFeatures = await TcpNegotiation.negotiateProtocolVersion(this._tcpClient, parameters);

        if (this._supportedFeatures.protocolVersion <= 0) {
            throwError("InvalidOperationException",
                this._options.subscriptionName
                + " : TCP negotiation resulted with an invalid protocol version: "
                + this._supportedFeatures.protocolVersion);
        }

        await this._sendOptions(this._tcpClient, this._options);

        if (this._subscriptionLocalRequestExecutor) {
            this._subscriptionLocalRequestExecutor.dispose();
        }

        this._subscriptionLocalRequestExecutor = RequestExecutor.createForSingleNodeWithoutConfigurationUpdates(
            command.requestedNode.url,
            this._dbName,
            {
                authOptions: requestExecutor.getAuthOptions(),
                documentConventions: requestExecutor.conventions
            }
        );

        return this._tcpClient;
    }

    private async _sendOptions(socket: Socket, options: SubscriptionWorkerOptions<T>) {
        const payload = {
            SubscriptionName: options.subscriptionName,
            TimeToWaitBeforeConnectionRetry:
                TimeUtil.millisToTimeSpan(options.timeToWaitBeforeConnectionRetry),
            IgnoreSubscriberErrors: options.ignoreSubscriberErrors || false,
            Strategy: options.strategy,
            MaxDocsPerBatch: options.maxDocsPerBatch,
            MaxErroneousPeriod:
                TimeUtil.millisToTimeSpan(options.maxErroneousPeriod),
            CloseWhenNoDocsLeft: options.closeWhenNoDocsLeft || false,
        };

        return new Promise<number>(resolve => {
            socket.write(JSON.stringify(payload, null, 0), () => resolve());
        });
    }

    private _ensureParser() {
        const keysTransformProfile = getTransformJsonKeysProfile(
            this._revisions 
                ? "SubscriptionRevisionsResponsePayload" 
                : "SubscriptionResponsePayload", this._store.conventions);

        this._parser = stream.pipeline([
            this._tcpClient,
            new Parser({ jsonStreaming: true, streamValues: false }),
            new TransformKeysJsonStream(keysTransformProfile),
            new StreamValues()
        ], err => {
            if (err && !this._tcpClient.destroyed) {
                this._emitter.emit("error", err);
            }
        }) as stream.Transform;

        this._parser.pause();
    }

    // noinspection JSUnusedLocalSymbols
    private async _readServerResponseAndGetVersion(url: string): Promise<number> {
        const x: any = await this._readNextObject();
        switch (x.status) {
            case "Ok":
                return x.version;
            case "AuthorizationFailed":
                throwError("AuthorizationException",
                        "Cannot access database " + this._dbName + " because " + x.message);
                return;
            case "TcpVersionMismatch":
                if (x.version !== OUT_OF_RANGE_STATUS) {
                    return x.version;
                }

                //Kindly request the server to drop the connection
                await this._sendDropMessage(x.value);
                throwError("InvalidOperationException",
                    "Can't connect to database " + this._dbName + " because: " + x.message);
        }

        return x.version;
    }

    private _sendDropMessage(reply: TcpConnectionHeaderResponse): Promise<number> {
        const dropMsg = {
            operation: "Drop",
            databaseName: this._dbName,
            operationVersion: SUBSCRIPTION_TCP_VERSION,
            info: "Couldn't agree on subscription tcp version ours: "
                + SUBSCRIPTION_TCP_VERSION + " theirs: " + reply.version
        } as TcpConnectionHeaderMessage;

        const payload = ObjectUtil.transformObjectKeys(dropMsg, {
            defaultTransform: "pascal"
        });

        return new Promise<number>(resolve => {
            this._tcpClient.write(JSON.stringify(payload, null, 0), () => resolve());
        });
    }

    private _assertConnectionState(connectionStatus: SubscriptionConnectionServerMessage) {
        if (connectionStatus.type === "Error") {
            if (connectionStatus.exception.includes("DatabaseDoesNotExistException")) {
                throwError("DatabaseDoesNotExistException",
                    this._dbName + " does not exists. " + connectionStatus.message);
            }
        }

        if (connectionStatus.type !== "ConnectionStatus") {
            throwError("InvalidOperationException",
                "Server returned illegal type message when expecting connection status, was: " + connectionStatus.type);
        }

        // noinspection FallThroughInSwitchStatementJS
        switch (connectionStatus.status) {
            case "Accepted":
                break;
            case "InUse":
                throwError("SubscriptionInUseException",
                    "Subscription with id " + this._options.subscriptionName
                    + " cannot be opened, because it's in use and the connection strategy is "
                    + this._options.strategy);
            case "Closed":
                throwError("SubscriptionClosedException",
                    "Subscription with id " + this._options.subscriptionName
                    + " was closed. " + connectionStatus.exception);
            case "Invalid":
                throwError("SubscriptionInvalidStateException",
                    "Subscription with id " + this._options.subscriptionName
                    + " cannot be opened, because it is in invalid state. " + connectionStatus.exception);
            case "NotFound":
                throwError("SubscriptionDoesNotExistException",
                    "Subscription with id " + this._options.subscriptionName
                    + " cannot be opened, because it does not exist. " + connectionStatus.exception);
            case "Redirect":
                const data = connectionStatus.data;
                const appropriateNode = data.redirectedTag;
                const error = getError("SubscriptionDoesNotBelongToNodeException",
                    "Subscription with id " + this._options.subscriptionName
                    + " cannot be processed by current node, it will be redirected to " + appropriateNode);
                (error as any).appropriateNode = appropriateNode;
                throw error;
            case "ConcurrencyReconnect":
                throwError("SubscriptionChangeVectorUpdateConcurrencyException", connectionStatus.message);
            default:
                throwError("InvalidOperationException",
                    "Subscription " + this._options.subscriptionName
                    + " could not be opened, reason: " + connectionStatus.status);
        }
    }

    private async _processSubscription() {
        try {
            if (this._processingCancelled) {
                throwError("OperationCancelledException");
            }

            const socket = await this._connectToServer();
            let notifiedSubscriber = Promise.resolve();
            let readFromServer = Promise.resolve<SubscriptionConnectionServerMessage[]>(null);
            try {
                if (this._processingCancelled) {
                    throwError("OperationCancelledException");
                }

                const tcpClientCopy = this._tcpClient;
                const connectionStatus: SubscriptionConnectionServerMessage = await this._readNextObject();

                if (this._processingCancelled) {
                    return;
                }

                if (connectionStatus.type !== "ConnectionStatus" || connectionStatus.status !== "Accepted") {
                    this._assertConnectionState(connectionStatus);
                }

                this._lastConnectionFailure = null;

                if (this._processingCancelled) {
                    return;
                }

                const batch = new SubscriptionBatch<T>(this._documentType, this._revisions,
                    this._subscriptionLocalRequestExecutor, this._store, this._dbName);

                while (!this._processingCancelled) {
                    // start the read from the server

                    readFromServer = this._readSingleSubscriptionBatchFromServer(batch);

                    try {
                        // and then wait for the subscriber to complete
                        await notifiedSubscriber;
                    } catch (err) {
                        // if the subscriber errored, we shut down
                        this._closeTcpClient();

                        // noinspection ExceptionCaughtLocallyJS
                        throw err;
                    }

                    const incomingBatch = await readFromServer;

                    if (this._processingCancelled) {
                        throwError("OperationCancelledException");
                    }

                    const lastReceivedChangeVector = batch.initialize(incomingBatch);
                    notifiedSubscriber = this._emitBatchAndWaitForProcessing(batch) 
                        .catch((err) => {
                            this._logger.error(err, "Subscription " + this._options.subscriptionName
                                + ". Subscriber threw an exception on document batch");

                            if (!this._options.ignoreSubscriberErrors) {
                                throwError("SubscriberErrorException",
                                    "Subscriber threw an exception in subscription "
                                    + this._options.subscriptionName, err);
                            }
                        })
                        .then(() => {
                            if (tcpClientCopy && tcpClientCopy.writable) {
                                return this._sendAck(lastReceivedChangeVector, tcpClientCopy);
                            }
                        });
                }
            } finally {
                socket.end();
                this._parser.end();

                try {
                    await notifiedSubscriber;
                } catch {
                    // we don't care anymore about errors from it
                }

                try {
                    await readFromServer;
                } catch {
                    // we don't care anymore about errors from it
                }
            }
        } catch (err) {
            if (!this._disposed) {
                throw err;
            }

            // otherwise this is thrown when shutting down, it
            // isn't an error, so we don't need to treat
            // it as such
        }
    }

    private async _emitBatchAndWaitForProcessing(batch): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let listenerCount = this._emitter.listenerCount("batch");
            this._emitter.emit("batch", batch, (error?: any) => {
                if (error) {
                    reject(error);
                } else {
                    listenerCount--;
                    if (!listenerCount) {
                        resolve();
                    }
                }
            });
        });
    }

    private async _readSingleSubscriptionBatchFromServer(batch: SubscriptionBatch<T>):
        Promise<SubscriptionConnectionServerMessage[]> {
        const incomingBatch = [] as SubscriptionConnectionServerMessage[];

        let endOfBatch = false;

        while (!endOfBatch && !this._processingCancelled) {
            const receivedMessage = await this._readNextObject();
            if (!receivedMessage || this._processingCancelled) {
                break;
            }

            switch (receivedMessage.type) {
                case "Data":
                    incomingBatch.push(receivedMessage);
                    break;
                case "EndOfBatch":
                    endOfBatch = true;
                    break;
                case "Confirm":
                    this._emitter.emit("afterAcknowledgment", batch);

                    incomingBatch.length = 0;
                    batch.items.length = 0;
                    break;
                case "ConnectionStatus":
                    this._assertConnectionState(receivedMessage);
                    break;
                case "Error":
                    this._throwSubscriptionError(receivedMessage);
                    break;
                default:
                    this._throwInvalidServerResponse(receivedMessage);
                    break;

            }
        }
        return incomingBatch;
    }

    private _throwInvalidServerResponse(receivedMessage: SubscriptionConnectionServerMessage) {
        throwError("InvalidArgumentException",
            "Unrecognized message " + receivedMessage.type + " type received from server");
    }

    private _throwSubscriptionError(receivedMessage: SubscriptionConnectionServerMessage) {
        throwError("InvalidOperationException",
            "Connection terminated by server. Exception: " + (receivedMessage.exception || "None"));
    }

    private async _readNextObject(): Promise<SubscriptionConnectionServerMessage> {
        const stream: NodeJS.ReadableStream = this._parser;
        if (this._processingCancelled) {
            return null;
        }

        if (this._disposed) { // if we are disposed, nothing to do...
            return null;
        }

        if (stream.readable) {
            const data: { key: number, value: SubscriptionConnectionServerMessage } = stream.read() as any;
            if (data) {
                return data.value;
            }
        }
        
        return new Promise((resolve, reject) => {
            stream.once("readable", readableListener); 
            stream.once("error", errorHandler);
            stream.once("end", endHandler);

            function readableListener() {
                stream.removeListener("error", errorHandler);
                stream.removeListener("end", endHandler);
                resolve();
            }

            function errorHandler(err) { 
                stream.removeListener("readable", readableListener);
                stream.removeListener("end", endHandler);
                reject(err);
            }

            function endHandler() {
                stream.removeListener("readable", readableListener);
                stream.removeListener("error", errorHandler);
                reject(getError("SubscriptionException", "Subscription stream has ended unexpectedly."));
            }
        })
        .then(() => this._readNextObject());
    }

    private async _sendAck(lastReceivedChangeVector: string, networkStream: Socket): Promise<void> {
        const payload = {
            ChangeVector: lastReceivedChangeVector,
            Type: "Acknowledge"
        };

        return new Promise<void>((resolve, reject) => {
            networkStream.write(JSON.stringify(payload, null, 0), (err) => {
                err ? reject(err) : resolve();
            });
        });
    }

    private async _runSubscriptionAsync(): Promise<void> {
        while (!this._processingCancelled) {
            try {
                this._closeTcpClient();

                this._logger.info("Subscription " + this._options.subscriptionName + ". Connecting to server...");
                await this._processSubscription();
            } catch (error) {
                if (this._processingCancelled) {
                    if (!this._disposed) {
                        throw error;
                    }
                    return;
                }

                this._logger.warn(error, "Subscription "
                    + this._options.subscriptionName + ". Pulling task threw the following exception. ");

                if (this._shouldTryToReconnect(error)) {
                    await delay(this._options.timeToWaitBeforeConnectionRetry);
                    this._emitter.emit("connectionRetry", error);
                } else {
                    this._logger.error(error, "Connection to subscription "
                        + this._options.subscriptionName + " have been shut down because of an error.");

                    throw error;
                }
            }
        }
    }

    private _lastConnectionFailure: Date;
    private _supportedFeatures: SupportedFeatures;

    private _assertLastConnectionFailure(lastError: Error) {
        if (!this._lastConnectionFailure) {
            this._lastConnectionFailure = new Date();
            return;
        }

        const maxErroneousPeriod =  this._options.maxErroneousPeriod;
        const erroneousPeriodDuration = new Date().getTime() - this._lastConnectionFailure.getTime();
        if (erroneousPeriodDuration > maxErroneousPeriod) {
            throwError("SubscriptionInvalidStateException",
                "Subscription connection was in invalid state for more than "
                + maxErroneousPeriod + " and therefore will be terminated.", lastError);
        }
    }

    private _shouldTryToReconnect(ex: Error) {
        if (ex.name === ("SubscriptionDoesNotBelongToNodeException" as RavenErrorType)) {
            this._assertLastConnectionFailure(ex);

            const requestExecutor = this._store.getRequestExecutor(this._dbName);

            const appropriateNode = (ex as any).appropriateNode;
            if (!appropriateNode) {
                return true;
            }

            const nodeToRedirectTo = requestExecutor.getTopologyNodes()
                .find(x => x.clusterTag === appropriateNode);

            if (!nodeToRedirectTo) {
                throwError("InvalidOperationException",
                    "Could not redirect to " + appropriateNode
                    + ", because it was not found in local topology, even after retrying");
            }

            this._redirectNode = nodeToRedirectTo;
            return true;
        } else if (ex.name === "SubscriptionChangeVectorUpdateConcurrencyException") {
            return true;
        }

        if (ex.name === "SubscriptionInUseException"
            || ex.name === "SubscriptionDoesNotExistException"
            || ex.name === "SubscriptionClosedException"
            || ex.name === "SubscriptionInvalidStateException"
            || ex.name === "DatabaseDoesNotExistException"
            || ex.name === "AuthorizationException"
            || ex.name === "AllTopologyNodesDownException"
            || ex.name === "SubscriberErrorException") {
            this._processingCancelled = true;
            return false;
        }

        this._assertLastConnectionFailure(ex);
        return true;
    }

    private _closeTcpClient() {
        if (this._tcpClient) {
            this._tcpClient.end();
        }
    }

    public on(event: "batch",
              handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public on(event: "error",
              handler: (error?: Error) => void);
    public on(event: "end",
              handler: (error?: Error) => void);
    public on(event: "afterAcknowledgment",
              handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public on(event: "connectionRetry",
              handler: (error?: Error) => void);
    public on(event: EventTypes,
              handler: 
                  ((batchOrError: SubscriptionBatch<T>, callback: EmptyCallback) => void)
                  | ((error: Error) => void)) {
        this._emitter.on(event, handler);

        if (event === "batch" && !this._subscriptionTask) {
            this._subscriptionTask = this._runSubscriptionAsync()
                .catch(err => { this._emitter.emit("error", err); })
                .then(() => { this._emitter.emit("end"); });
        }

        return this;
    }

    public off(event: "batch", handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public off(event: "error", handler: (error?: Error) => void);
    public off(event: "end", handler: (error?: Error) => void);
    public off(event: "afterAcknowledgment", handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public off(event: "connectionRetry", handler: (error?: Error) => void);
    public off(event: EventTypes,
               handler:
                  ((batchOrError: SubscriptionBatch<T>, callback: EmptyCallback) => void)
                  | ((error: Error) => void)) {
        this._emitter.removeListener(event, handler);
        return this;
    }

    public removeListener(event: "batch", handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public removeListener(event: "error", handler: (error?: Error) => void);
    public removeListener(event: "end", handler: (error?: Error) => void);
    public removeListener(
        event: "afterAcknowledgment", handler: (value: SubscriptionBatch<T>, callback: EmptyCallback) => void);
    public removeListener(event: "connectionRetry", handler: (error?: Error) => void);
    public removeListener(
        event: EventTypes,
        handler:
            ((batchOrError: SubscriptionBatch<T>, callback: EmptyCallback) => void)
            | ((error: Error) => void)) {
        this.removeListener(event as any, handler as any);
        return this;
    }

    public removeAllListeners(); 
    public removeAllListeners(event: "batch" | "error" | "end" | "connectionRetry"); 
    public removeAllListeners(event?: "batch" | "error" | "end" | "connectionRetry") {
        this._emitter.removeAllListeners(event);
        return this;
    }

}
