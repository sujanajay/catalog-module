// No server imports: the client error page uses this too.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A batch id is a UUID; anything else is treated as no batch. */
export const isUuid = (value: string): boolean => UUID.test(value);
