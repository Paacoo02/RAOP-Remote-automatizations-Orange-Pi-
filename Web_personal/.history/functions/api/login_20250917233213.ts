import { Env, verifyCredentials, issueSession, cookieHeader } from '../_utils/auth';


export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
try {
const contentType = request.headers.get('content-type') || '';
let user = '', pass = '';


if (contentType.includes('application/json')) {
const body = await request.json();
user = (body.username || '').toString();
pass = (body.password || '').toString();
} else if (contentType.includes('application/x-www-form-urlencoded')) {
const body = await request.formData();
user = String(body.get('username') || '');
pass = String(body.get('password') || '');
} else {
return new Response(JSON.stringify({ error: 'Unsupported Content-Type' }), { status: 415 });
}


if (!(await verifyCredentials(env, user, pass))) {
return new Response(JSON.stringify({ error: 'Credenciales inválidas' }), { status: 401 });
}


const token = await issueSession(env, user);


return new Response(JSON.stringify({ ok: true }), {
headers: {
'content-type': 'application/json',
'set-cookie': cookieHeader(env, token),
},
});
} catch (e: any) {
return new Response(JSON.stringify({ error: 'Login error' }), { status: 500 });
}
};