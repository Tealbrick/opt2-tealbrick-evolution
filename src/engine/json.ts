// JSON value type shared by the engine files (type only: nothing runs from this file).
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
