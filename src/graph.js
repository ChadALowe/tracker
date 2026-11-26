// Microsoft Graph, using the app's own identity (client credentials), so no one
// has to be signed in for the Worker to check presence.
//
// Needs application permissions Presence.Read.All and User.Read.All with admin consent.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedToken = null; // { key, token, expiresAt } — survives while the isolate stays warm

function loginBase(env) { return (env.LOGIN_BASE_URL || "https://login.microsoftonline.com").replace(/\/$/, ""); }
function graphBase(env) { return (env.GRAPH_BASE_URL || "https://graph.microsoft.com").replace(/\/$/, ""); }

export function connectionStatus(env) {
    return {
        tenantId: Boolean(env.AZURE_TENANT_ID),
        clientId: Boolean(env.AZURE_CLIENT_ID),
        clientSecret: Boolean(env.AZURE_CLIENT_SECRET)
    };
}

export function isConfigured(env) {
    const s = connectionStatus(env);
    return s.tenantId && s.clientId && s.clientSecret;
}

export async function getAppToken(env) {
    if (!isConfigured(env)) {
        throw new Error("The Microsoft connection isn't set up yet. Add AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET to the Worker.");
    }
    const key = `${env.AZURE_TENANT_ID}|${env.AZURE_CLIENT_ID}`;
    if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now() + 2 * 60 * 1000) {
        return cachedToken.token;
    }
    const body = new URLSearchParams({
        client_id: env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        scope: `${graphBase(env)}/.default`,
        grant_type: "client_credentials"
    });
    const response = await fetch(`${loginBase(env)}/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        const reason = data.error_description ? data.error_description.split("\r\n")[0] : `HTTP ${response.status}`;
        throw new Error(`Microsoft sign-in for the Worker failed: ${reason}`);
    }
    cachedToken = { key, token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return cachedToken.token;
}

async function graphError(response, what) {
    const text = await response.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text).error.message || text; } catch { /* keep raw text */ }
    if (response.status === 403) {
        message += " — check the app has the application permissions Presence.Read.All and User.Read.All, with admin consent granted.";
    }
    return new Error(`${what} failed (${response.status}): ${message}`.slice(0, 600));
}

// Map of userId -> presence object, or an Error for that person.
export async function fetchPresences(env, token, ids) {
    const results = new Map();
    const batchable = ids.filter((id) => GUID_RE.test(id));
    const single = ids.filter((id) => !GUID_RE.test(id));

    for (let i = 0; i < batchable.length; i += 650) {
        const chunk = batchable.slice(i, i + 650);
        try {
            const response = await fetch(`${graphBase(env)}/v1.0/communications/getPresencesByUserId`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ ids: chunk })
            });
            if (!response.ok) throw await graphError(response, "Presence check");
            const data = await response.json();
            (data.value || []).forEach((p) => results.set(p.id, p));
            chunk.forEach((id) => { if (!results.has(id)) results.set(id, new Error("No presence returned for this person.")); });
        } catch (error) {
            chunk.forEach((id) => results.set(id, error));
        }
    }

    for (const id of single) {
        try {
            const response = await fetch(`${graphBase(env)}/v1.0/users/${encodeURIComponent(id)}/presence`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) throw await graphError(response, "Presence check");
            results.set(id, await response.json());
        } catch (error) {
            results.set(id, error);
        }
    }
    return results;
}

export async function searchUsers(env, token, term) {
    let url = `${graphBase(env)}/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=30`;
    const clean = String(term || "").trim();
    if (clean) {
        const safe = clean.replaceAll("'", "''");
        url += `&$filter=${encodeURIComponent(`startswith(displayName,'${safe}') or startswith(mail,'${safe}') or startswith(userPrincipalName,'${safe}')`)}`;
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } });
    if (!response.ok) throw await graphError(response, "User lookup");
    const data = await response.json();
    return (data.value || []).map((u) => ({ id: u.id, displayName: u.displayName, mail: u.mail, userPrincipalName: u.userPrincipalName }));
}
