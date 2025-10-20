// Utilidades: SHA-256 y JWT HS256 (firmar/verificar) usando Web Crypto API.


export async function sha256Hex(input: ArrayBuffer | string): Promise<string> {
    const enc = new TextEncoder();
    const data = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    
    function b64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    
    
    function b64urlFromString(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    
    
    async function importHmacKey(secret: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
    }
    
    
    export async function signJWT(payload: Record<string, any>, secret: string): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encHeader = b64urlFromString(JSON.stringify(header));
    const encPayload = b64urlFromString(JSON.stringify(payload));
    const data = new TextEncoder().encode(`${encHeader}.${encPayload}`);
    const key = await importHmacKey(secret);
    const sig = await crypto.subtle.sign('HMAC', key, data);
    const encSig = b64url(sig);
    return `${encHeader}.${encPayload}.${encSig}`;
    }
    
    
    export async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const key = await importHmacKey(secret);
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!ok) return null;
    const json = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    // Comprobar expiración si existe
    if (typeof json.exp === 'number' && Date.now() / 1000 > json.exp) return null;
    return json;
    }