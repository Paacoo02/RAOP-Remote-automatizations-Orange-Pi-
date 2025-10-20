import { Env, readSession } from './_utils/auth';


const PROTECTED_PREFIXES = ['/dashboard.html', '/apps/'];


export const onRequest: PagesFunction<Env> = async (ctx) => {
const { request, env, next } = ctx;
const url = new URL(request.url);


const needsAuth = PROTECTED_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p));
if (!needsAuth) return next();


const session = await readSession(env, request);
if (session) return next();


// No autenticado → redirigir a inicio
return Response.redirect(new URL('/index.html', url), 302);
};