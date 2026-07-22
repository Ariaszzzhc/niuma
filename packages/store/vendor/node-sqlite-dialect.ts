import {
  type DatabaseConnection,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
  type CompiledQuery,
  type DatabaseIntrospector,
  type SchemaMetadata,
  type TableMetadata,
  type ColumnMetadata,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
// node:sqlite is shipped with Deno (and Node 22+). Importing the symbol
// triggers the node-compat shim that exposes DatabaseSync as a constructor.
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

interface DatabaseSyncRunResult {
  changes?: number;
  lastInsertRowid?: number | bigint;
}

interface DatabaseSyncStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): DatabaseSyncRunResult;
  values(...params: unknown[]): unknown[][];
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}

// Structural view of the node:sqlite DatabaseSync class — the parts the
// dialect actually calls. Kept as an interface so this file type-checks even
// if node:sqlite's exact public shape drifts.
interface DatabaseSyncLike {
  prepare(sql: string): DatabaseSyncStatement;
  exec(sql: string): unknown;
  close(): void;
  function(name: string, fn: (...args: unknown[]) => unknown): void;
}

export interface NodeSqliteDialectConfig {
  database: DatabaseSyncLike;
}

class NodeSqliteConnection implements DatabaseConnection {
  #database: DatabaseSyncLike;

  constructor(database: DatabaseSyncLike) {
    this.#database = database;
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.#database.prepare(compiledQuery.sql);
    const params = compiledQuery.parameters;
    try {
      const result = stmt.all(...params) as R[];
      return Promise.resolve({
        rows: result as R[],
        numAffectedRows: BigInt(result.length),
        insertId: undefined,
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  streamQuery<R>(
    compiledQuery: CompiledQuery,
  ): AsyncIterableIterator<QueryResult<R>> {
    const stmt = this.#database.prepare(compiledQuery.sql);
    const iter = stmt.iterate(...compiledQuery.parameters) as IterableIterator<R>;
    const self = this;
    const asyncIter: AsyncIterableIterator<QueryResult<R>> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<QueryResult<R>>> {
        const step = iter.next();
        if (step.done) {
          return { value: undefined, done: true };
        }
        const row = step.value as R;
        return Promise.resolve({
          value: { rows: [row], numAffectedRows: 1n, insertId: undefined },
          done: false,
        });
      },
      async return(): Promise<IteratorResult<QueryResult<R>>> {
        return { value: undefined, done: true };
      },
      async throw(err: unknown): Promise<IteratorResult<QueryResult<R>>> {
        throw err;
      },
    };
    return self.#wrapStream(asyncIter);
  }

  async *#wrapStream<R>(
    iter: AsyncIterableIterator<QueryResult<R>>,
  ): AsyncIterableIterator<QueryResult<R>> {
    for await (const v of iter) yield v;
  }
}

class NodeSqliteDriver implements Driver {
  #database: DatabaseSyncLike;
  #connection: NodeSqliteConnection | null;
  #transactionDepth: number;

  constructor(config: NodeSqliteDialectConfig) {
    this.#database = config.database;
    this.#connection = null;
    this.#transactionDepth = 0;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<NodeSqliteConnection> {
    return new NodeSqliteConnection(this.#database);
  }

  async beginTransaction(connection: NodeSqliteConnection): Promise<void> {
    if (this.#transactionDepth === 0) {
      this.#database.exec("BEGIN");
    } else {
      this.#database.exec(`SAVEPOINT tx_${this.#transactionDepth}`);
    }
    this.#transactionDepth += 1;
    await Promise.resolve();
  }

  async commitTransaction(connection: NodeSqliteConnection): Promise<void> {
    if (this.#transactionDepth === 1) {
      this.#database.exec("COMMIT");
    } else {
      this.#database.exec(`RELEASE tx_${this.#transactionDepth - 1}`);
    }
    this.#transactionDepth -= 1;
    await Promise.resolve();
  }

  async rollbackTransaction(connection: NodeSqliteConnection): Promise<void> {
    if (this.#transactionDepth === 1) {
      this.#database.exec("ROLLBACK");
    } else {
      this.#database.exec(
        `ROLLBACK TO tx_${this.#transactionDepth - 1}`,
      );
    }
    this.#transactionDepth -= 1;
    await Promise.resolve();
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.#database.close();
  }
}

export class NodeSqliteDialect implements Dialect {
  #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

export function createNodeSqliteDialect(
  location: string,
  options?: { readOnly?: boolean },
): NodeSqliteDialect {
  const db = new NodeDatabaseSync(location, options) as unknown as DatabaseSyncLike;
  return new NodeSqliteDialect({ database: db });
}
