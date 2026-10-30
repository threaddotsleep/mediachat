import "dotenv/config";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import maxmind from "maxmind";
import sharp from "sharp";

const port = Number(process.env.PORT ?? 3000);
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() ?? "";
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
const adsensePublisherId = process.env.ADSENSE_PUBLISHER_ID?.trim() ?? "";
if (adsensePublisherId && !/^ca-pub-\d{16}$/.test(adsensePublisherId)) {
    throw new Error("ADSENSE_PUBLISHER_ID must be a Google AdSense ID in the format ca-pub-1234567890123456.");
}
const adsenseSellerId = adsensePublisherId.replace(/^ca-/, "");
const turnstileConfigured = Boolean(turnstileSiteKey && turnstileSecretKey);
if (Boolean(turnstileSiteKey) !== Boolean(turnstileSecretKey)) {
    throw new Error("Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to enable CAPTCHA.");
}
const page = (await readFile(new URL("./index.html", import.meta.url), "utf8"))
    .replace("__TURNSTILE_SITE_KEY__", turnstileSiteKey.replace(/[&<>\"]/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;"
    })[character]))
    .replace("<!-- ADSENSE_SCRIPT -->", adsensePublisherId
        ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsensePublisherId}" crossorigin="anonymous"></script>`
        : "");
const outputDirectory = process.env.MEDIA_DIRECTORY
    ? resolve(process.env.MEDIA_DIRECTORY)
    : fileURLToPath(new URL("./converted/", import.meta.url));
const maximumUploads = 100;
const categories = [
    { id: "general", name: "General" },
    { id: "asian", name: "Asian" },
    { id: "ebony", name: "Ebony" },
    { id: "latina", name: "Latina" }
];
const categoriesById = new Map(categories.map((category) => [category.id, category]));
const voteHashSecretPath = join(outputDirectory, ".vote-hash-secret");
const reportReasons = new Set(["DMCA", "Dox (Personal Info)", "Underage", "Bad Content"]);
const reportDirectory = join(outputDirectory, "reports");
const auditDirectory = process.env.AUDIT_DIRECTORY
    ? resolve(process.env.AUDIT_DIRECTORY)
    : join(outputDirectory, "audit");
const auditLogPath = join(auditDirectory, "content-events.jsonl");
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
const anonymousIpDatabasePath = process.env.MAXMIND_ANONYMOUS_IP_DB;
const anonymousIpBlockingEnabled = process.env.BLOCK_ANONYMOUS_IPS === "true";
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
}
if (anonymousIpBlockingEnabled && !anonymousIpDatabasePath) {
    throw new Error("Set MAXMIND_ANONYMOUS_IP_DB when BLOCK_ANONYMOUS_IPS=true.");
}
await mkdir(outputDirectory, { recursive: true });
let voteHashSecret;
try {
    voteHashSecret = await readFile(voteHashSecretPath);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
    voteHashSecret = randomBytes(32);
    try {
        await writeFile(voteHashSecretPath, voteHashSecret, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        voteHashSecret = await readFile(voteHashSecretPath);
    }
}
await chmod(voteHashSecretPath, 0o600);
await mkdir(reportDirectory, { recursive: true });
await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
await chmod(auditDirectory, 0o700);
try {
    await chmod(auditLogPath, 0o600);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
const pendingCommentWrites = new Map();
let mediaRetentionQueue = Promise.resolve();
let auditQueue = Promise.resolve();
const anonymousIpReader = anonymousIpBlockingEnabled && anonymousIpDatabasePath
    ? await maxmind.open(anonymousIpDatabasePath)
    : null;
if (anonymousIpBlockingEnabled && !anonymousIpReader) {
    throw new Error("Could not initialize the MaxMind Anonymous IP database.");
}
if (!anonymousIpBlockingEnabled) {
    console.warn("VPN/Tor blocking is disabled. Set BLOCK_ANONYMOUS_IPS=true and MAXMIND_ANONYMOUS_IP_DB to enable it.");
}

function sendJson(response, status, data) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
}

async function requireValidCaptcha(token, expectedAction, request, response) {
    if (!turnstileConfigured) {
        sendJson(response, 503, { error: "Content submissions are unavailable until CAPTCHA is configured." });
        return false;
    }
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
        sendJson(response, 400, { error: "Complete the CAPTCHA verification and try again." });
        return false;
    }

    const verificationData = new URLSearchParams({
        secret: turnstileSecretKey,
        response: token
    });
    const clientIp = getClientIp(request);
    if (isIP(clientIp)) verificationData.set("remoteip", clientIp);

    try {
        const verificationResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: verificationData,
            signal: AbortSignal.timeout(5000)
        });
        if (!verificationResponse.ok) throw new Error("Turnstile verification request failed.");
        const result = await verificationResponse.json();
        if (result.success && result.action === expectedAction) return true;
        sendJson(response, 403, { error: "CAPTCHA verification failed. Please try again." });
        return false;
    } catch (error) {
        console.error("Turnstile verification unavailable:", error.message);
        sendJson(response, 503, { error: "CAPTCHA verification is temporarily unavailable. Please try again." });
        return false;
    }
}

function getClientIp(request) {
    const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/i, "") ?? "unknown";
    if (trustedProxyHops === 0) return remoteAddress;

    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") return remoteAddress;
    const addresses = forwarded.split(",").map((address) => address.trim().replace(/^::ffff:/i, ""));
    const forwardedClient = addresses[addresses.length - trustedProxyHops];
    return forwardedClient && isIP(forwardedClient) ? forwardedClient : remoteAddress;
}

function appendAuditEvent(request, event) {
    const record = {
        ...event,
        ipAddress: getClientIp(request),
        timestampUtc: new Date().toISOString()
    };
    const write = auditQueue.then(() => appendFile(auditLogPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600
    }));
    auditQueue = write.catch((error) => {
        console.error("Failed to write content audit log:", error);
    });
    return write;
}

function isPrivateAddress(address) {
    return address === "::1" || address.startsWith("127.") || address.startsWith("10.") ||
        address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
        address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
}

function checkAnonymousIp(address) {
    if (!anonymousIpBlockingEnabled || !anonymousIpReader || address === "unknown" || isPrivateAddress(address)) {
        return null;
    }
    const result = anonymousIpReader.get(address);
    if (!result) return null;
    if (result.is_anonymous_vpn) return "VPN";
    if (result.is_tor_exit_node) return "Tor exit node";
    if (result.is_public_proxy) return "public proxy";
    if (result.is_anonymous) return "anonymous network";
    return null;
}

async function readRequestJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) {
            throw new Error("Comment request is too large.");
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readComments(imageId) {
    try {
        return JSON.parse(await readFile(join(outputDirectory, `${imageId}.comments.json`), "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

async function addComment(imageId, text) {
    const previousWrite = pendingCommentWrites.get(imageId) ?? Promise.resolve();
    const nextWrite = previousWrite.then(async () => {
        const comments = await readComments(imageId);
        const comment = { id: randomUUID(), text, createdAt: new Date().toISOString() };
        comments.push(comment);
        const destination = join(outputDirectory, `${imageId}.comments.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(comments), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, destination);
        return comment;
    });
    const queuedWrite = nextWrite.catch(() => {});
    pendingCommentWrites.set(imageId, queuedWrite);
    try {
        return await nextWrite;
    } finally {
        if (pendingCommentWrites.get(imageId) === queuedWrite) {
            pendingCommentWrites.delete(imageId);
        }
    }
}

async function getMedia(imageId) {
    for (const [extension, kind] of [["avif", "image"], ["webm", "video"]]) {
        try {
            const details = await stat(join(outputDirectory, `${imageId}.${extension}`));
            let category = "general";
            let votes = 0;
            try {
                const metadata = JSON.parse(await readFile(join(outputDirectory, `${imageId}.meta.json`), "utf8"));
                if (categoriesById.has(metadata.category)) category = metadata.category;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            try {
                const voteData = JSON.parse(await readFile(join(outputDirectory, `${imageId}.votes.json`), "utf8"));
                if (Number.isSafeInteger(voteData.score)) votes = voteData.score;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            return {
                id: imageId,
                kind,
                category,
                votes,
                url: `/converted/${imageId}.${extension}`,
                createdAt: details.mtime.toISOString()
            };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    return null;
}

function castVote(mediaId, delta, clientIp) {
    const vote = mediaRetentionQueue.then(async () => {
        const media = await getMedia(mediaId);
        if (!media) return { missing: true };

        let voteData = { score: media.votes, voters: {} };
        try {
            voteData = JSON.parse(await readFile(join(outputDirectory, `${mediaId}.votes.json`), "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (!Number.isSafeInteger(voteData.score)) voteData.score = media.votes;
        if (!voteData.voters || typeof voteData.voters !== "object" || Array.isArray(voteData.voters)) {
            voteData.voters = {};
        }

        const voterHash = createHmac("sha256", voteHashSecret)
            .update(mediaId)
            .update("\0")
            .update(clientIp)
            .digest("hex");
        if (Object.hasOwn(voteData.voters, voterHash)) {
            return { removed: false, alreadyVoted: true, score: voteData.score };
        }

        const score = voteData.score + delta;
        if (score <= -10) {
            await Promise.all([
                rm(join(outputDirectory, `${mediaId}.${media.kind === "image" ? "avif" : "webm"}`), { force: true }),
                rm(join(outputDirectory, `${mediaId}.comments.json`), { force: true }),
                rm(join(outputDirectory, `${mediaId}.meta.json`), { force: true }),
                rm(join(outputDirectory, `${mediaId}.votes.json`), { force: true })
            ]);
            return { removed: true, score: -10 };
        }

        voteData.score = score;
        voteData.voters[voterHash] = delta;
        const destination = join(outputDirectory, `${mediaId}.votes.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(voteData), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, destination);
        return { removed: false, alreadyVoted: false, score };
    });
    mediaRetentionQueue = vote.catch(() => {});
    return vote;
}

async function listStoredMedia() {
    const entries = await readdir(outputDirectory, { withFileTypes: true });
    const media = [];
    for (const entry of entries) {
        const match = entry.isFile() && entry.name.match(/^([0-9a-f-]{36})\.(avif|webm)$/i);
        if (!match) continue;
        const details = await stat(join(outputDirectory, entry.name));
        let category = "general";
        try {
            const metadata = JSON.parse(await readFile(join(outputDirectory, `${match[1]}.meta.json`), "utf8"));
            if (categoriesById.has(metadata.category)) category = metadata.category;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        media.push({ id: match[1], extension: match[2].toLowerCase(), category, modifiedAt: details.mtimeMs });
    }
    return media;
}

async function enforceUploadLimit() {
    const media = await listStoredMedia();
    for (const category of categories) {
        const categoryMedia = media
            .filter((item) => item.category === category.id)
            .sort((first, second) => first.modifiedAt - second.modifiedAt || first.id.localeCompare(second.id));
        while (categoryMedia.length > maximumUploads) {
            const oldest = categoryMedia.shift();
            await Promise.all([
                rm(join(outputDirectory, `${oldest.id}.${oldest.extension}`), { force: true }),
                rm(join(outputDirectory, `${oldest.id}.comments.json`), { force: true }),
                rm(join(outputDirectory, `${oldest.id}.meta.json`), { force: true }),
                rm(join(outputDirectory, `${oldest.id}.votes.json`), { force: true })
            ]);
        }
    }
}

function registerMedia(media) {
    const registration = mediaRetentionQueue.then(async () => {
        const finalPath = join(outputDirectory, `${media.id}.${media.extension}`);
        const metadataPath = join(outputDirectory, `${media.id}.meta.json`);
        const temporaryMetadataPath = `${metadataPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryMetadataPath, JSON.stringify({ category: media.category }), { encoding: "utf8", mode: 0o600 });
        await rename(temporaryMetadataPath, metadataPath);
        await rename(media.temporaryPath, finalPath);
        const now = new Date();
        await utimes(finalPath, now, now);
        await enforceUploadLimit();
        return {
            id: media.id,
            extension: media.extension,
            kind: media.kind,
            category: media.category,
            originalFilename: media.originalFilename,
            uploadedBytes: media.uploadedBytes
        };
    });
    mediaRetentionQueue = registration.catch(() => {});
    return registration;
}

function convertVideo(stream, outputPath) {
    const ffmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "4",
        "-c:a", "libopus", "-f", "webm", "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let errorOutput = "";
    ffmpeg.stderr.on("data", (chunk) => {
        if (errorOutput.length < 4096) errorOutput += chunk.toString();
    });

    const outputLimit = new Transform({
        transform(chunk, encoding, callback) {
            this.bytesWritten = (this.bytesWritten ?? 0) + chunk.length;
            if (this.bytesWritten > 200 * 1024 * 1024) {
                callback(new Error("Converted video exceeds the 200 MB output limit."));
                return;
            }
            callback(null, chunk);
        }
    });

    const input = pipeline(stream, ffmpeg.stdin);
    const output = pipeline(ffmpeg.stdout, outputLimit, createWriteStream(outputPath));
    const exited = new Promise((resolve, reject) => {
        ffmpeg.once("error", reject);
        ffmpeg.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(errorOutput.trim() || `FFmpeg exited with code ${code}.`));
        });
    });

    return Promise.all([input, output, exited]).then(() => undefined).catch((error) => {
        ffmpeg.kill("SIGKILL");
        throw error;
    });
}

function receiveMedia(request, category) {
    return new Promise((resolve, reject) => {
        let fileSeen = false;
        let uploadError;
        let conversion;
        const parser = busboy({
            headers: request.headers,
            limits: { files: 1, fileSize: 20 * 1024 * 1024 }
        });

        parser.on("file", (fieldName, stream, info) => {
            if (fieldName !== "file" || fileSeen) {
                uploadError = new Error("Choose one image or video file to upload.");
                stream.resume();
                return;
            }

            fileSeen = true;
            const kind = info.mimeType.startsWith("image/") ? "image" :
                info.mimeType.startsWith("video/") ? "video" : null;
            if (!kind) {
                uploadError = new Error("Only image and video files are supported.");
                stream.resume();
                return;
            }
            let uploadedBytes = 0;
            stream.on("data", (chunk) => {
                uploadedBytes += chunk.length;
            });
            let fileTooLarge = false;
            stream.on("limit", () => {
                fileTooLarge = true;
            });

            const id = randomUUID();
            const extension = kind === "image" ? "avif" : "webm";
            const temporaryPath = join(outputDirectory, `${id}.${extension}.tmp`);
            const convert = kind === "image"
                ? pipeline(stream, sharp().avif({ quality: 60 }), createWriteStream(temporaryPath))
                : convertVideo(stream, temporaryPath);
            conversion = convert
                .then(async () => {
                    if (fileTooLarge) {
                        throw new Error("Media file exceeds the 20 MB upload limit.");
                    }
                    return {
                        id,
                        extension,
                        kind,
                        category,
                        temporaryPath,
                        originalFilename: (info.filename ?? "").split(/[\\/]/).pop().slice(0, 255),
                        uploadedBytes
                    };
                })
                .catch(async (error) => {
                    await rm(temporaryPath, { force: true });
                    throw error;
                });
        });

        parser.on("filesLimit", () => {
            uploadError = new Error("Upload one image at a time.");
        });
        parser.on("error", reject);
        parser.on("close", async () => {
            if (uploadError) {
                if (conversion) {
                    try {
                        const { temporaryPath } = await conversion;
                        await rm(temporaryPath, { force: true });
                    } catch {}
                }
                reject(uploadError);
                return;
            }
            if (!fileSeen || !conversion) {
                reject(new Error("Choose an image or video file to upload."));
                return;
            }
            try {
                resolve(await registerMedia(await conversion));
            } catch (error) {
                reject(error);
            }
        });

        request.pipe(parser);
    });
}

await enforceUploadLimit();

const server = createServer(async (request, response) => {
    const clientIp = getClientIp(request);
    if (anonymousIpBlockingEnabled) {
        try {
            const blockedReason = checkAnonymousIp(clientIp);
            if (blockedReason) {
                sendJson(response, 403, { error: `Connections through ${blockedReason}s are not allowed.` });
                return;
            }
        } catch (error) {
            console.error("Anonymous IP lookup failed:", error);
            sendJson(response, 503, { error: "Connection screening is temporarily unavailable." });
            return;
        }
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = requestUrl.pathname;
    const commentsRoute = pathname.match(/^\/api\/images\/([0-9a-f-]{36})\/comments$/i);
    const reportsRoute = pathname.match(/^\/api\/media\/([0-9a-f-]{36})\/reports$/i);
    const imagePageRoute = pathname.match(/^\/image\/([0-9a-f-]{36})$/i);

    if (request.method === "GET" && pathname === "/ads.txt" && adsenseSellerId) {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`google.com, ${adsenseSellerId}, DIRECT, f08c47fec0942fa0\n`);
        return;
    }

    if (reportsRoute && request.method === "POST") {
        const mediaId = reportsRoute[1];
        getMedia(mediaId).then(async (media) => {
            if (!media) {
                sendJson(response, 404, { error: "Media not found." });
                return;
            }

            const body = await readRequestJson(request);
            const reason = typeof body.reason === "string" ? body.reason : "";
            const description = typeof body.description === "string" ? body.description.trim() : "";
            if (!reportReasons.has(reason) || !description || description.length > 2000) {
                sendJson(response, 400, { error: "Select a reason and describe the violation in 1 to 2000 characters." });
                return;
            }

            const report = {
                id: randomUUID(),
                mediaId,
                reason,
                description,
                submittedAt: new Date().toISOString()
            };
            await writeFile(join(reportDirectory, `${report.id}.json`), JSON.stringify(report), {
                encoding: "utf8",
                mode: 0o600
            });
            sendJson(response, 201, { message: "Report submitted." });
        }).catch((error) => {
            const tooLarge = error.message.includes("too large");
            sendJson(response, tooLarge ? 413 : 400, {
                error: tooLarge ? error.message : "Could not submit this report."
            });
        });
        return;
    }

    if (commentsRoute && (request.method === "GET" || request.method === "POST")) {
        const imageId = commentsRoute[1];
        getMedia(imageId).then(async (media) => {
            if (!media) {
                sendJson(response, 404, { error: "Image not found." });
                return;
            }

            if (request.method === "GET") {
                sendJson(response, 200, await readComments(imageId));
                return;
            }

            const body = await readRequestJson(request);
            if (!await requireValidCaptcha(body.captchaToken, "comment", request, response)) return;
            const text = typeof body.text === "string" ? body.text.trim() : "";
            if (!text || text.length > 1000) {
                sendJson(response, 400, { error: "Comments must be between 1 and 1000 characters." });
                return;
            }
            const comment = await addComment(imageId, text);
            await appendAuditEvent(request, {
                action: "comment_posted",
                mediaId: imageId,
                commentId: comment.id,
                text: comment.text
            });
            sendJson(response, 201, comment);
        }).catch((error) => {
            const tooLarge = error.message.includes("too large");
            sendJson(response, tooLarge ? 413 : 400, {
                error: tooLarge ? error.message : "Could not process this comment."
            });
        });
        return;
    }

    if (imagePageRoute && request.method === "GET") {
        getMedia(imagePageRoute[1]).then((media) => {
            if (!media) {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Image not found");
                return;
            }
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(page);
        });
        return;
    }

    if (request.method === "GET" && pathname === "/styles.css") {
        readFile(new URL("./styles.css", import.meta.url))
            .then((stylesheet) => {
                response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
                response.end(stylesheet);
            })
            .catch(() => {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Not found");
            });
        return;
    }

    if (request.method === "GET" && pathname === "/app.js") {
        readFile(new URL("./app.js", import.meta.url))
            .then((script) => {
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
                response.end(script);
            })
            .catch(() => {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Not found");
            });
        return;
    }

    if (request.method === "POST" && pathname === "/upload") {
        const category = request.headers["x-media-category"];
        if (!categoriesById.has(category)) {
            sendJson(response, 400, { error: "Choose a valid upload category." });
            return;
        }
        if (!await requireValidCaptcha(request.headers["x-turnstile-token"], "upload", request, response)) return;
        receiveMedia(request, category)
            .then(async (media) => {
                await appendAuditEvent(request, {
                    action: "media_uploaded",
                    mediaId: media.id,
                    mediaKind: media.kind,
                    category: media.category,
                    originalFilename: media.originalFilename,
                    uploadedBytes: media.uploadedBytes
                });
                sendJson(response, 201, {
                    url: `/converted/${media.id}.${media.extension}`,
                    kind: media.kind
                });
            })
            .catch((error) => {
                const tooLarge = error.message.includes("20 MB");
                const outputTooLarge = error.message.includes("200 MB");
                const status = tooLarge || outputTooLarge ? 413 : 400;
                const knownUploadError = /^(Only image and video|Choose one image or video|Choose an image or video|Upload one image)/.test(error.message);
                sendJson(response, status, {
                    error: tooLarge || outputTooLarge || knownUploadError ? error.message : "Could not convert this media file."
                });
            });
        return;
    }

    const voteRoute = pathname.match(/^\/api\/media\/([0-9a-f-]{36})\/vote$/i);
    if (request.method === "POST" && voteRoute) {
        try {
            const body = await readRequestJson(request);
            if (body.delta !== 1 && body.delta !== -1) {
                sendJson(response, 400, { error: "Vote must be either +1 or -1." });
                return;
            }
            const result = await castVote(voteRoute[1], body.delta, getClientIp(request));
            if (result.missing) {
                sendJson(response, 404, { error: "Media not found." });
                return;
            }
            sendJson(response, 200, result);
        } catch {
            sendJson(response, 400, { error: "Could not record this vote." });
        }
        return;
    }

    const mediaDetailsRoute = pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && mediaDetailsRoute) {
        getMedia(mediaDetailsRoute[1]).then((media) => {
            if (!media) {
                sendJson(response, 404, { error: "Media not found." });
                return;
            }
            sendJson(response, 200, media);
        }).catch(() => sendJson(response, 500, { error: "Could not load this media." }));
        return;
    }

    if (request.method === "GET" && ["/api/images", "/api/media"].includes(pathname)) {
        readdir(outputDirectory, { withFileTypes: true })
            .then(async (entries) => {
                const mediaIds = new Set(entries
                    .filter((entry) => entry.isFile())
                    .map((entry) => entry.name.match(/^([0-9a-f-]{36})\.(?:avif|webm)$/i)?.[1])
                    .filter(Boolean));
                const media = (await Promise.all([...mediaIds].map(getMedia))).filter(Boolean);
                media.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
                const category = requestUrl.searchParams.get("category");
                if (category && category !== "all" && !categoriesById.has(category)) {
                    sendJson(response, 400, { error: "Choose a valid category." });
                    return;
                }
                sendJson(response, 200, category && category !== "all"
                    ? media.filter((item) => item.category === category)
                    : media);
            })
            .catch(() => sendJson(response, 500, { error: "Could not load uploaded media." }));
        return;
    }

    if (request.method === "GET" && pathname === "/api/categories") {
        listStoredMedia().then((media) => {
            const counts = new Map(categories.map((category) => [category.id, 0]));
            for (const item of media) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
            sendJson(response, 200, categories.map((category) => ({
                ...category,
                count: counts.get(category.id),
                limit: maximumUploads
            })));
        }).catch(() => sendJson(response, 500, { error: "Could not load categories." }));
        return;
    }

    if (request.method === "GET" && pathname.startsWith("/converted/")) {
        const match = pathname.match(/^\/converted\/([0-9a-f-]{36})\.(avif|webm)$/i);
        if (match) {
            const contentType = match[2].toLowerCase() === "avif" ? "image/avif" : "video/webm";
            const mediaPath = join(outputDirectory, `${match[1]}.${match[2].toLowerCase()}`);
            stat(mediaPath)
                .then(() => {
                    response.writeHead(200, { "Content-Type": contentType });
                    createReadStream(mediaPath)
                        .on("error", (error) => response.destroy(error))
                        .pipe(response);
                })
                .catch(() => {
                    response.writeHead(404);
                    response.end("Not found");
                });
            return;
        }
    }

    if (request.method !== "GET" || !["/", "/index.html"].includes(pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
});

server.listen(port, "127.0.0.1", () => {
    console.log(`MediaChat is running at http://127.0.0.1:${port}`);
});