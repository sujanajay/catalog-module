import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Client } from "pg";
import { isConnectionError } from "./connection-error";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("isConnectionError", () => {
  it.each([
    "Connection terminated",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ])("the driver's message with no code: %s", message => {
    expect(isConnectionError(new Error(message))).toBe(true);
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH"])("a socket code: %s", code => {
    expect(isConnectionError(coded(`read ${code}`, code))).toBe(true);
  });

  it.each(["08000", "08001", "08003", "08006", "08P01", "57P01", "57P02", "57P03", "53300", "57014"])("a server SQLSTATE: %s", code => {
    expect(isConnectionError(coded("server message", code))).toBe(true);
  });

  it("finds the driver's error inside drizzle's wrapper and inside an AggregateError", () => {
    expect(isConnectionError(new DrizzleQueryError("update x", [], new Error("Connection terminated unexpectedly")))).toBe(true);
    expect(isConnectionError(new AggregateError([new Error("nope"), coded("connect ECONNREFUSED", "ECONNREFUSED")]))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated due to connection timeout", { cause: new Error("x") }))).toBe(true);
  });

  it("a photo fault, a SQL fault or a message that only mentions a connection is not one", () => {
    expect(isConnectionError(new Error("Input buffer has corrupt header"))).toBe(false);
    expect(isConnectionError(new Error("No object gs://assets/raw/Connection terminated unexpectedly.jpg"))).toBe(false);
    expect(isConnectionError(coded("duplicate key", "23505"))).toBe(false);
    expect(isConnectionError(coded("not a code we know", "ENOENT"))).toBe(false);
    expect(isConnectionError(new DrizzleQueryError("update x", [], coded("duplicate key", "23505")))).toBe(false);
    expect(isConnectionError(Object.assign(new Error("grpc"), { code: 14 }))).toBe(false);
    expect(isConnectionError("Connection terminated unexpectedly")).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });

  it("stops on an error that is its own cause", () => {
    const loop = new Error("loop") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(isConnectionError(loop)).toBe(false);
  });
});

describe("the real pg client", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())); server = undefined; });
  const listen = async (onSocket: (socket: Socket) => void) => {
    const s = createServer(onSocket);
    server = s;
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
    return (s.address() as AddressInfo).port;
  };
  const failure = async (port: number) => {
    const client = new Client({ host: "127.0.0.1", port, user: "u", database: "d", password: "p" });
    client.on("error", () => {});
    return client.connect().then(() => null, (error: unknown) => error);
  };

  it("a server that hangs up gives an error this recognises", async () => {
    const error = await failure(await listen(socket => { socket.on("error", () => {}); socket.once("data", () => socket.end()); }));
    expect(String((error as Error).message)).toBe("Connection terminated unexpectedly");
    expect(isConnectionError(error)).toBe(true);
  });

  it("a port nobody listens on gives an error this recognises", async () => {
    const port = await listen(() => {});
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    const error = await failure(port);
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(isConnectionError(error)).toBe(true);
  });
});
