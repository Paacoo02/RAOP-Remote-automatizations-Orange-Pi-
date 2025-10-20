import { sha256Hex, signJWT, verifyJWT } from './crypto';


export interface Env {
ADMIN_USER: string;
ADMIN_PW_HASH: string; // SHA-256 hex de (password + PEPPER)
PEPPER: string;
JWT_SECRET: string;
SESSION_TTL_SECONDS: string | number;
COOKIE_NAME: string;
}


export async function verifyCredentials(env: Env, user: string, pass: string): Promise<boolean> {
if (user !== env.ADMIN_USER) return false;
const candidate = await sha256Hex(`${pass}${env.PEPPER}`);
return timingSafeEqualHex(candidate, env.ADMIN_PW_HASH);
}


function timingSafeEqualHex(a: string, b: string): boolean {
if (a.length !== b.length) return false;
let res = 0;
for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
return res === 0;
}


export async function issueSession(env: Env, sub: string): Promise<string> {
const ttl = Number(env.SESSION_TTL_SECONDS || 28800);
const now = Math.floor(Date.now() / 1000);
const payload = { sub, iat: now, exp: now + ttl };
return signJWT(payload, env.JWT_SECRET);
}


export async function readSession(env: Env, req: Request): Promise<{ sub: string } | null> {
const cookie = getCookie(req.headers.get('cookie') || '', env.COOKIE_NAME);
if (!cookie) return null;
const data = await verifyJWT(cookie, env.JWT_SECRET);
if (!data || typeof data.sub !== 'string') return null;
return { sub: data.sub };
}


export function cookieHeader(env: Env, token: string | null) {
const name = env.COOKIE_NAME || 'auth';
if (!token) {
// Expirar
return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
const ttl = Number(env.SESSION_TTL_SECONDS || 28800);
return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
}


function getCookie(cookieHeader: string, name: string): string | null {
const m = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
return m ? decodeURIComponent(m[1]) : null;
}