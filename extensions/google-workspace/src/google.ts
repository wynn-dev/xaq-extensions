// W1 owns this; identical copy until rebase
export interface GoogleClient {
  json<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T>;
  bytes(method: "GET" | "POST", url: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; contentType?: string }): Promise<{ data: Buffer; contentType: string }>;
}
