/**
 * LogicPOS Stock Report Fetcher
 * Pulls POS Closing Stock Report - Item Wise for THE LABEL LIFE PUNE
 */

const crypto = require('crypto');
const https = require('https');
const { Pool } = require('pg');
require('dotenv').config();

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const CLOUD_URL        = "https://cloud.logicerpcloud.com";
const CLOUD_USERNAME   = process.env.CLOUD_USERNAME || "GBLPL_4";
const CLOUD_PASSWORD   = process.env.CLOUD_PASSWORD || "Voylla@123";

const APP_USERNAME_IDX = 19;          // "Admin" is index 19 in the user dropdown
const APP_PASSWORD     = process.env.APP_PASSWORD || "Voylla@123";
const AES_KEY_IV       = process.env.AES_KEY_IV || "8080808080808080";

const COMPANY_FIN_YEAR_IDX = 0;       // 2025-2026
const BRANCH_CODE      = 28;          // THE LABEL LIFE PUNE
const BRANCH_ROW_IDX   = 53;          // 0-based row index in branch selection grid

const REPORT_CLASS     = "Stock_Qry_New_Proc|734";
const CONFIG_IDX       = 20;          // "POS CLOSING STOCK REPORT - ITEM WISE"
const PAGE_SIZE        = 500;
const REPORTS_SERVER   = process.env.REPORTS_SERVER || "db3reports3"; // reports server is fixed regardless of which pos server is assigned

// Database Config
const DB_HOST          = process.env.DB_HOST || "localhost";
const DB_PORT          = process.env.DB_PORT || "5432";
const DB_NAME          = process.env.DB_NAME || "postgres";
const DB_USER          = process.env.DB_USER || "postgres";
const DB_PASSWORD      = process.env.DB_PASSWORD || "";
const DB_SCHEMA        = process.env.DB_SCHEMA || "public";
const DB_TABLE         = process.env.DB_TABLE || "Ebo_inventory";
const BRAND_NAME       = process.env.BRAND_NAME || "THE LABEL LIFE";
// ───────────────────────────────────────────────────────────────────────────────

function aesEncrypt(value) {
    const key = Buffer.from(AES_KEY_IV, 'utf8');
    const iv = Buffer.from(AES_KEY_IV, 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    let enc = cipher.update(String(value), 'utf8', 'base64');
    enc += cipher.final('base64');
    return enc;
}

class Session {
    constructor() {
        this.cookies = new Map();
    }

    _extractCookies(headers) {
        let setCookies = headers['set-cookie'];
        if (!setCookies) return;
        if (!Array.isArray(setCookies)) setCookies = [setCookies];
        
        for (const cookieStr of setCookies) {
            const firstPart = cookieStr.split(';')[0];
            const eqIdx = firstPart.indexOf('=');
            if (eqIdx !== -1) {
                const name = firstPart.substring(0, eqIdx).trim();
                const value = firstPart.substring(eqIdx + 1).trim();
                this.cookies.set(name, value);
            }
        }
    }

    _getCookieString() {
        const parts = [];
        for (const [name, value] of this.cookies.entries()) {
            parts.push(`${name}=${value}`);
        }
        return parts.join('; ');
    }

    async _req(urlStr, options, postData, redirectCount = 0) {
        if (redirectCount > 5) throw new Error("Too many redirects");
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const method = options.method || 'GET';
            const baseHeaders = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            };
            if (method === 'POST') {
                baseHeaders['X-Requested-With'] = 'XMLHttpRequest';
            }
            const reqOptions = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method,
                rejectUnauthorized: false,
                secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                minVersion: 'TLSv1',
                headers: { ...baseHeaders, ...options.headers }
            };

            const cookieStr = this._getCookieString();
            if (cookieStr) {
                reqOptions.headers['Cookie'] = cookieStr;
            }

            const req = https.request(reqOptions, (res) => {
                this._extractCookies(res.headers);

                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const destUrl = new URL(res.headers.location, urlStr).toString();
                        return resolve(this._req(destUrl, { method: 'GET', headers: {} }, null, redirectCount + 1));
                    }
                    resolve({ status: res.statusCode, body, headers: res.headers });
                });
            });

            req.on('error', (e) => reject(e));

            if (postData) {
                req.write(postData);
            }
            req.end();
        });
    }

    async get(url, headers = {}) {
        return this._req(url, { method: 'GET', headers });
    }

    async post(url, data = null, headers = {}) {
        let postData = '';
        const reqHeaders = { ...headers };

        if (data && typeof data === 'object') {
            postData = JSON.stringify(data);
            reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
        } else if (typeof data === 'string') {
            postData = data;
            reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
            reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
        }

        if (postData) {
            reqHeaders['Content-Length'] = Buffer.byteLength(postData);
        }

        return this._req(url, { method: 'POST', headers: reqHeaders }, postData);
    }

    async postJson(url, data = null) {
        const res = await this.post(url, data);
        try {
            return JSON.parse(res.body);
        } catch(e) {
            return res.body; 
        }
    }
}

// ── STEP 1 : Cloud login ────────────────────────────────────────────────────────
async function step1CloudLogin(s) {
    console.log("[1] Logging into cloud.logicerpcloud.com ...");
    await s.get(`${CLOUD_URL}/Login/UserLogin`);

    const params = new URLSearchParams();
    params.append('UserName', CLOUD_USERNAME);
    params.append('Password', CLOUD_PASSWORD);
    params.append('DeviceID', '1234567890');
    params.append('Browser', 'Chrome 120.0.0.0');
    params.append('BrowserInfo', 'Mozilla/5.0 (Macintosh)');
    params.append('Platform', 'Mac OS X 10.15.7');
    params.append('RememberMe', 'False');

    await s.post(`${CLOUD_URL}/Login/UserLogin`, params.toString(), {
        'Referer': `${CLOUD_URL}/Login/UserLogin`
    });

    const data = await s.postJson(`${CLOUD_URL}/Base/GetValidateExpiryToken`, {});
    const cloudUrl = data.CloudLoginURL || '';
    console.log("    Cloud redirect URL obtained.");
    return cloudUrl;
}

// ── STEP 2 : Follow redirect to app server ──────────────────────────────────────
async function step2FollowRedirect(s, cloudUrl) {
    console.log("[2] Following redirect to app server ...");
    await s.get(cloudUrl);
}

// ── STEP 3 : Second login (Admin) ───────────────────────────────────────────────
async function step3AppLogin(s, BASE) {
    console.log("[3] Second login (Admin) ...");

    await s.postJson(`${BASE}/Login/GetUserLoginControls`, { clientKey: '1234567890' });

    const encIdx = aesEncrypt(APP_USERNAME_IDX);
    const encPass = aesEncrypt(APP_PASSWORD);

    const result = await s.postJson(`${BASE}/Login/Login`, {
        userNameIndex: encIdx,
        password: encPass,
        deviceFingerPrint: '1234567890',
        browser: 'Chrome',
    });
    
    if (String(result) !== '2') {
        throw new Error(`Unexpected login response: ${result}`);
    }
    console.log("    User authenticated (step 2 of login).");
}

// ── STEP 4 : Select company / fin year ─────────────────────────────────────────
async function step4Company(s, BASE) {
    console.log("[4] Selecting company and financial year ...");
    
    const now = new Date();
    const currDate = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    
    const result = await s.postJson(`${BASE}/Login/ValidateCompanyInfo`, {
        finYearIndex: COMPANY_FIN_YEAR_IDX,
        currDate: currDate,
    });
    
    if (String(result) !== '3') {
        throw new Error(`Unexpected company response: ${result}`);
    }
    console.log("    Company selected (GOAT BRAND LABS, FY 2025-26).");
}

// ── STEP 5 : Select branch ──────────────────────────────────────────────────────
async function step5Branch(s, BASE) {
    console.log("[5] Selecting branch (THE LABEL LIFE PUNE, code 28) ...");
    const result = await s.postJson(`${BASE}/Login/ValidateBranch`, { branchCode: BRANCH_CODE });
    
    if (String(result) !== '5') {
        throw new Error(`Unexpected branch response: ${result}`);
    }
    console.log("    Branch selected → home page reached.");
}

// ── STEP 6 : Access reports server ─────────────────────────────────────────────
async function step6AccessReports(s, APP_BASE, REPORTS_BASE) {
    console.log("[6] Accessing reports server ...");
    await s.get(`${APP_BASE}/Home/Index`);

    // Also visit the pos server matching the reports server (db3reportsN → db3posN)
    // so the right domain-wide cookie is set when APP_BASE is a different server number
    const matchingPosBase = REPORTS_BASE.replace(/reports(\d+)$/, 'pos$1');
    if (matchingPosBase !== APP_BASE) {
        await s.get(`${matchingPosBase}/Home/Index`);
    }

    const res = await s.get(`${REPORTS_BASE}/Report/List?className=${encodeURIComponent(REPORT_CLASS)}`);
    if (res.status !== 200) {
        throw new Error(`Reports page returned ${res.status}`);
    }
    console.log("    Reports server accessible.");
}

// ── STEP 7 : Init report & set filters ─────────────────────────────────────────
async function step7InitReport(s, BASE) {
    console.log("[7] Initialising report settings ...");

    let r = await s.postJson(`${BASE}/Report/InitializeSettings`, {
        clientId: 'client1',
        className: REPORT_CLASS,
    });
    if (r && typeof r === 'object' && r.ErrorMessage) {
        throw new Error(`InitializeSettings error: ${r.ErrorMessage}`);
    }

    await s.postJson(`${BASE}/Report/GetUIControls`, { className: REPORT_CLASS });

    await s.postJson(`${BASE}/Report/ComboConfiguration_SelectedIndexChange`, {
        className: REPORT_CLASS,
        paraSelectedIndex: CONFIG_IDX,
    });

    await s.postJson(`${BASE}/Report/LstFinYear_CheckedChange`, {
        className: REPORT_CLASS,
        rowIndex: 0,
        paraCheck: true,
    });

    console.log("    Report initialised, FY 2025-2026 selected.");
}

// ── STEP 8 : Branch filter selection ───────────────────────────────────────────
async function step8SelectBranchFilter(s, BASE) {
    console.log("[8] Selecting Branch filter (THE LABEL LIFE PUNE) ...");

    await s.postJson(`${BASE}/Report/LstSelections_CheckedChange`, {
        className: REPORT_CLASS,
        rowIndex: 7,
        paraCheck: true,
    });

    await s.post(`${BASE}/FrmBranchSelection/FrmBranchSelection`, {});

    await s.postJson(`${BASE}/FrmBranchSelection/GetBranchSelectionData`, {});

    await s.postJson(`${BASE}/FrmBranchSelection/DialogResultOK`, {
        selectedIndexes: String(BRANCH_ROW_IDX),
    });

    console.log("    Branch filter set to THE LABEL LIFE PUNE.");
}

// ── STEP 9 : Create report ──────────────────────────────────────────────────────
const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function step9CreateReport(s, BASE) {
    console.log("[9] Creating report (this may take ~30s) ...");

    await s.postJson(`${BASE}/Report/CreateReport`, {
        className: REPORT_CLASS,
        width: 1200,
    });

    for (let attempt = 0; attempt < 30; attempt++) {
        await delay(5000);
        const status = await s.postJson(`${BASE}/Report/UpdateReportProgress`, {
            className: REPORT_CLASS,
            reportCancel: false,
        });
        const pct = status.Percentage || 0;
        const done = status.ReportCreated || false;
        const err = status.ErrorMessage || '';
        
        process.stdout.write(`\r    Progress: ${pct}%`);
        
        if (done && !err) {
            console.log(`\n    Report ready!`);
            return;
        }
        if (err) {
            throw new Error(`Report generation failed:\n${err}`);
        }
    }
    throw new Error("Report did not complete in 150 seconds.");
}

// ── STEP 10 : Download all pages ────────────────────────────────────────────────
async function step10Download(s, BASE) {
    console.log("[10] Downloading report data ...");

    const first = await s.postJson(`${BASE}/Report/GetRepGridData`, { className: REPORT_CLASS });
    const cols = (first.Columns || []).map(c => c.Header || '');
    const allRows = Array.from(first.Rows || []);
    const total = first.TotalRows || 0;
    console.log(`    Page 1: ${allRows.length} rows  (total=${total})`);

    let page = 1;
    while (allRows.length < total) {
        page++;
        const data = await s.postJson(`${BASE}/Report/GetRepGridDataUsingPaging`, {
            className: REPORT_CLASS,
            pageSize: PAGE_SIZE,
            currentPage: page,
        });
        const rows = data.Rows || [];
        allRows.push(...rows);
        console.log(`    Page ${page}: +${rows.length} rows  (total so far=${allRows.length})`);
        if (rows.length === 0) break;
    }

    return { cols, rows: allRows };
}

// ── STEP 11 : Save to Database ─────────────────────────────────────────────────
async function step11SaveToDb(cols, rows) {
    console.log("[11] Saving data to PostgreSQL database ...");
    
    const pool = new Pool({
        host: DB_HOST,
        port: parseInt(DB_PORT, 10),
        database: DB_NAME,
        user: DB_USER,
        password: DB_PASSWORD
    });

    const client = await pool.connect();

    try {
        const cleanCols = cols.map(c => String(c).trim().replace(/ /g, '_').replace(/\./g, '').replace(/-/g, '_').toLowerCase());
        cleanCols.push("brand");

        await client.query('BEGIN');

        // Delete today's existing rows for this brand before re-inserting (idempotent daily run)
        await client.query(
            `DELETE FROM "${DB_SCHEMA}"."${DB_TABLE}" WHERE "brand" = $1 AND sync_timestamp::date = CURRENT_DATE`,
            [BRAND_NAME]
        );

        const placeholders = cleanCols.map((_, i) => `$${i + 1}`).join(', ');
        const colNames = cleanCols.map(c => `"${c}"`).join(', ');
        const insertQuery = `INSERT INTO "${DB_SCHEMA}"."${DB_TABLE}" (${colNames}) VALUES (${placeholders})`;

        for (const row of rows) {
            const rowData = [...row];
            if (rowData.length < cols.length) {
                while(rowData.length < cols.length) rowData.push(null);
            } else if (rowData.length > cols.length) {
                rowData.length = cols.length;
            }
            rowData.push(BRAND_NAME);
            
            const params = rowData.map(val => val === null || val === undefined ? null : String(val));
            await client.query(insertQuery, params);
        }

        await client.query('COMMIT');
        console.log(`    Saved ${rows.length} rows to schema/table '"${DB_SCHEMA}"."${DB_TABLE}"'.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Database error:", err);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

// ── MAIN ────────────────────────────────────────────────────────────────────────
async function main() {
    try {
        const s = new Session();

        const cloudUrl = await step1CloudLogin(s);
        await step2FollowRedirect(s, cloudUrl);

        // Derive app + reports server base from the cloud redirect URL
        // cloudUrl looks like https://b.logicerpcloud.com/db3posN/home?Data=...
        const appBase = new URL(cloudUrl).origin + '/' + new URL(cloudUrl).pathname.split('/')[1];
        const reportsBase = `https://b.logicerpcloud.com/${REPORTS_SERVER}`;
        console.log(`    App base: ${appBase}`);

        await step3AppLogin(s, appBase);
        await step4Company(s, appBase);
        await step5Branch(s, appBase);
        await step6AccessReports(s, appBase, reportsBase);
        await step7InitReport(s, reportsBase);
        await step8SelectBranchFilter(s, reportsBase);
        await step9CreateReport(s, reportsBase);
        const { cols, rows } = await step10Download(s, reportsBase);

        await step11SaveToDb(cols, rows);

        console.log(`\n✓ Done! Data successfully saved to database table: "${DB_SCHEMA}"."${DB_TABLE}"`);
    } catch (e) {
        console.error("Fatal error:", e);
    }
}

main();
