import test from "node:test";
import assert from "node:assert/strict";
import { getClientIp, isPrivateAddress } from "../network.js";

function makeRequest(remoteAddress, forwardedFor) {
    return {
        socket: { remoteAddress },
        headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }
    };
}

test("getClientIp ignores forwarded addresses when no proxy is trusted", () => {
    const request = makeRequest("203.0.113.8", "198.51.100.4");

    assert.equal(getClientIp(request), "203.0.113.8");
});

test("getClientIp selects the client address based on trusted proxy hops", () => {
    const request = makeRequest("10.0.0.2", "198.51.100.4, 10.0.0.1");

    assert.equal(getClientIp(request, 1), "10.0.0.1");
    assert.equal(getClientIp(request, 2), "198.51.100.4");
});

test("getClientIp falls back to the socket address for missing or invalid forwarding data", () => {
    const request = makeRequest("::ffff:192.0.2.9", "not-an-ip");

    assert.equal(getClientIp(request, 1), "192.0.2.9");
    assert.equal(getClientIp(makeRequest(undefined), 1), "unknown");
});

test("isPrivateAddress recognizes private and local address ranges", () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.1", "::1", "fc00::1", "fd12::1", "fe80::1"]) {
        assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
});

test("isPrivateAddress leaves public addresses eligible for screening", () => {
    for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888"]) {
        assert.equal(isPrivateAddress(address), false, `${address} should not be private`);
    }
});