import EventEmitter from "events";
import {QueryService, SessionBuilder, SessionEvent} from "./query-session-pool";
import {Endpoint} from "../discovery";
import {retryable} from "../retries_obsoleted";
import {pessimizable} from "../utils";
import {ensureCallSucceeded} from "../utils/process-ydb-operation-result";
import {Ydb} from "ydb-sdk-proto";
import {ClientReadableStream} from "@grpc/grpc-js";
import {
    sessionIdSymbol,
    sessionTxSettingsSymbol,
    sessionTxIdSymbol,
    sessionCurrentOperationSymbol,
    sessionAcquireSymbol,
    sessionReleaseSymbol,
    sessionAttachSymbol,
    sessionIsFreeSymbol,
    sessionIsDeletedSymbol,
    sessionDeleteOnReleaseSymbol,
    sessionRollbackTransactionSymbol,
    sessionCommitTransactionSymbol,
    sessionBeginTransactionSymbol,
    createSymbol,
    sessionIsClosingSymbol
} from './symbols';
import ICreateSessionResult = Ydb.Table.ICreateSessionResult;

import {attach as attachImpl} from './query-session-attach';
import {CANNOT_MANAGE_TRASACTIONS_ERROR, execute as executeImpl} from './query-session-execute';
import {
    beginTransaction,
    beginTransaction as beginTransactionImpl, commitTransaction,
    commitTransaction as commitTransactionImpl,
    rollbackTransaction as rollbackTransactionImpl
} from './query-session-transaction';
import {Logger} from "../logger/simple-logger";

/**
 * Service methods, as they name in GRPC.
 */
export const enum Query_V1 {
    CreateSession = '/Ydb.Query.V1.QueryService/CreateSession',
    DeleteSession = '/Ydb.Query.V1.QueryService/DeleteSession',
    AttachSession = '/Ydb.Query.V1.QueryService/AttachSession',
    BeginTransaction = '/Ydb.Query.V1.QueryService/BeginTransaction',
    CommitTransaction = '/Ydb.Query.V1.QueryService/CommitTransaction',
    RollbackTransaction = '/Ydb.Query.V1.QueryService/RollbackTransaction',
    ExecuteQuery = '/Ydb.Query.V1.QueryService/ExecuteQuery',
    ExecuteScript = '/Ydb.Query.V1.QueryService/ExecuteScript',
    FetchScriptResults = '/Ydb.Query.V1.QueryService/FetchScriptResults',
}

export interface QuerySessionOperation {
    cancel(reason: any): void;
}

export const apiSymbol = Symbol('api');
export const implSymbol = Symbol('impl');
export const attachStreamSymbol = Symbol('attachStream');

export class QuerySession extends EventEmitter implements ICreateSessionResult {
    [sessionCurrentOperationSymbol]?: QuerySessionOperation;
    [sessionIdSymbol]: string;
    [sessionTxIdSymbol]?: string;
    [sessionTxSettingsSymbol]?: Ydb.Query.ITransactionSettings;

    // private fields, available in the methods placed in separated files
    [implSymbol]: SessionBuilder;
    [attachStreamSymbol]?: ClientReadableStream<Ydb.Query.SessionState>;
    [apiSymbol]: QueryService;

    // TODO: Move those fields to SessionBase
    private beingDeleted = false;
    private free = true;
    private closing = false;

    public get sessionId() {
        return this[sessionIdSymbol];
    }

    public get txId() {
        return this[sessionTxIdSymbol];
    }

    private constructor( // TODO: Change to named parameters for consistency
        _api: QueryService,
        _impl: SessionBuilder,
        public endpoint: Endpoint,
        sessionId: string,
        public readonly logger: Logger,
        // TODO: Add timeout
    ) {
        super();
        this[apiSymbol] = _api;
        this[implSymbol] = _impl;
        this[sessionIdSymbol] = sessionId;
    }

    static [createSymbol](
        api: QueryService,
        impl: SessionBuilder,
        endpoint: Endpoint,
        sessionId: string,
        logger: Logger,
    ) {
        return new QuerySession(api, impl, endpoint, sessionId, logger);
    }

    [sessionAcquireSymbol]() {
        this.free = false;
        this.logger.debug(`Acquired session ${this.sessionId} on endpoint ${this.endpoint.toString()}.`);
        return this;
    }

    [sessionReleaseSymbol]() {
        if (this[sessionCurrentOperationSymbol]) throw new Error('There is an active operation');
        this.free = true;
        this.logger.debug(`Released session ${this.sessionId} on endpoint ${this.endpoint.toString()}.`);
        this.emit(SessionEvent.SESSION_RELEASE, this);
    }

    [sessionIsFreeSymbol]() {
        return this.free && !this[sessionIsDeletedSymbol]();
    }

    [sessionIsClosingSymbol]() {
        return this.closing;
    }

    public [sessionDeleteOnReleaseSymbol]() {
        this.closing = true;
    }

    [sessionIsDeletedSymbol]() {
        return this.beingDeleted;
    }

    @retryable()
    @pessimizable
    public async delete(): Promise<void> {
        if (this[sessionIsDeletedSymbol]()) return;
        this.beingDeleted = true;
        await this[attachStreamSymbol]?.cancel();
        delete this[attachStreamSymbol]; // only one stream cancel even when multi ple retries
        ensureCallSucceeded(await this[apiSymbol].deleteSession({sessionId: this.sessionId}));
    }

    // TODO: Uncomment after switch to TS 5.3
    // [Symbol.asyncDispose]() {
    //     return this.delete();
    // }

    [sessionAttachSymbol] = attachImpl;

    public async beginTransaction(txSettings: Ydb.Query.ITransactionSettings | null = null) {
        if (this[sessionTxSettingsSymbol]) throw new Error(CANNOT_MANAGE_TRASACTIONS_ERROR);
        return beginTransaction.call(this, txSettings);
    }

    public async commitTransaction() {
        if (this[sessionTxSettingsSymbol]) throw new Error(CANNOT_MANAGE_TRASACTIONS_ERROR);
        return commitTransaction.call(this);
    }

    public async rollbackTransaction() {
        if (this[sessionTxSettingsSymbol]) throw new Error(CANNOT_MANAGE_TRASACTIONS_ERROR);
        return rollbackTransactionImpl.call(this);
    }

    public [sessionBeginTransactionSymbol] = beginTransactionImpl;
    public [sessionCommitTransactionSymbol] = commitTransactionImpl;
    public [sessionRollbackTransactionSymbol] = rollbackTransactionImpl;

    public execute = executeImpl;
}
