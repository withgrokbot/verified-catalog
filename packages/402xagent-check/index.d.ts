export declare const DEFAULT_BASE: string;
export declare const CHECK_PATH: string;
export interface Verdict { verdict: "pay" | "skip" | "recheck"; reason?: string; reason_code?: string; [k: string]: unknown }
export interface CheckOptions { base?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }
export declare class CheckError extends Error { status: number; body: unknown }
export declare function checkUrl(url: string, opts?: { base?: string }): string;
export declare function check(url: string, opts?: CheckOptions): Promise<Verdict>;
export default check;
