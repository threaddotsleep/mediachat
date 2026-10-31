import { isIP } from "node:net";

export function getClientIp(request, trustedProxyHops = 0) {
    const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/i, "") ?? "unknown";
    if (trustedProxyHops === 0) return remoteAddress;

    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") return remoteAddress;
    const addresses = forwarded.split(",").map((address) => address.trim().replace(/^::ffff:/i, ""));
    const forwardedClient = addresses[addresses.length - trustedProxyHops];
    return forwardedClient && isIP(forwardedClient) ? forwardedClient : remoteAddress;
}

export function isPrivateAddress(address) {
    return address === "::1" || address.startsWith("127.") || address.startsWith("10.") ||
        address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
        address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
}