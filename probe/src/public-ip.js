// Refuse connections to non-public addresses. The address we probe is chosen from DNS for a
// customer-supplied domain, so loopback, link-local, private and documentation ranges are not targets.
import { isIP, BlockList } from "node:net";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(net, bits, "ipv4");
blocked.addAddress("255.255.255.255", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
for (const [net, bits] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]]) blocked.addSubnet(net, bits, "ipv6");

export function isPublicIp(ip) {
  const kind = isIP(String(ip || ""));
  if (!kind) return false;
  const s = String(ip);
  if (kind === 6 && /^::ffff:/i.test(s)) return false;
  return !blocked.check(s, kind === 6 ? "ipv6" : "ipv4");
}
