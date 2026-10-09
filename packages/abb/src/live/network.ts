/**
 * Can this controller be reached without the service port, and at which address? Read from the
 * controller's own configuration:
 *
 *   /rw/cfg/SIO/IP_SETTING/instances   an address per port: -Address, -Mask, -Interface (WAN, LAN2, LAN3...),
 *                                      DHCP where the controller gets its address from the network
 *   /rw/cfg/SIO/CSGW_WIRELESS          the wireless gateway, when one is set up and enabled
 *   /rw/system options                 IRC5 answers Robot Web Services on its public (WAN) port only with
 *                                      PC Interface (616-1); without it, only on the service port
 *
 * A configuration instance comes from RWS as an item followed by one item per attribute (both
 * dialects: XHTML `cfg-dt-instance-li` then `cfg-ia-t` items, HAL+JSON the same `_type`s), so
 * {@link cfgInstances} reads either. Pure; the controller-side reading is AbbControllers.readExtra.
 */
import type { RwsPage } from '../rws/xhtml';

export const SERVICE_PORT_IP = '192.168.125.1';

export interface CfgInstance { name: string; attrs: Record<string, string> }

/** The instances of a configuration type, each with its attributes by name. */
export function cfgInstances(page: RwsPage): CfgInstance[] {
  const out: CfgInstance[] = [];
  for (const it of page.items) {
    if (/instance/i.test(it.cls)) {
      const attrs: Record<string, string> = {};
      // attributes may also come as fields of the instance itself
      for (const [k, v] of Object.entries(it.fields)) if (k !== 'name') attrs[k] = v;
      out.push({ name: it.fields.name ?? it.title, attrs });
    } else if (/cfg-ia/i.test(it.cls) && out.length) {
      const v = it.fields.value ?? Object.values(it.fields)[0];
      if (it.title && v !== undefined) out[out.length - 1].attrs[it.title] = v;
    }
  }
  return out;
}

const attr = (i: CfgInstance, ...names: string[]) => {
  for (const n of names) { const k = Object.keys(i.attrs).find(a => a.toLowerCase() === n.toLowerCase()); if (k) return i.attrs[k]; }
  return undefined;
};

export interface PortSetting { name: string; port?: string; address?: string; mask?: string; dhcp: boolean; label?: string }

/** IP_SETTING instances as ports and addresses. */
export function ipSettings(instances: CfgInstance[]): PortSetting[] {
  return instances.map(i => {
    const address = attr(i, 'Address', 'IPAddress');
    const dhcp = /^(true|yes|on|1)$/i.test(attr(i, 'DHCP', 'UseDHCP') ?? '') || /dhcp/i.test(address ?? '');
    return { name: i.name, port: attr(i, 'Interface', 'Port'), address: dhcp ? undefined : address, mask: attr(i, 'Mask', 'SubnetMask'), dhcp, label: attr(i, 'Label') };
  });
}

/** Is a wireless gateway set up and switched on? Undefined when the controller has none configured. */
export function wirelessEnabled(instances: CfgInstance[] | undefined): boolean | undefined {
  if (!instances?.length) return undefined;
  return instances.some(i => { const e = attr(i, 'Enabled', 'Enable', 'Active'); return e === undefined || /^(true|yes|on|1)$/i.test(e); });
}

export const hasPcInterface = (options: readonly string[]) => options.some(o => /616-1|PC Interface/i.test(o));

export interface Reachability {
  /** true: only the service port (192.168.125.1) answers RWS */
  serviceOnly: boolean;
  /** the address to use off the service port, when there is one */
  ip?: string;
  /** which port that address is on */
  via?: string;
  /** one line for the page */
  verdict: string;
  /** why, line by line */
  notes: string[];
}

const usable = (p: PortSetting) => !!p.address && p.address !== '0.0.0.0' && !p.address.startsWith('192.168.125.');
const isWan = (p: PortSetting) => /wan|public|lan1|x6/i.test(p.port ?? p.name);

export function reachability(family: 'irc5' | 'omnicore', ports: PortSetting[], wireless: boolean | undefined, options: readonly string[]): Reachability {
  const notes: string[] = [];
  const wan = ports.filter(isWan);
  const addressed = ports.filter(usable);
  const best = addressed.find(isWan) ?? addressed[0];
  const dhcp = wan.some(p => p.dhcp) || (!wan.length && ports.some(p => p.dhcp));
  for (const p of ports) notes.push(`${p.port ?? p.name}: ${p.dhcp ? 'DHCP' : p.address ?? 'no address'}${p.mask ? ` / ${p.mask}` : ''}${p.label ? ` (${p.label})` : ''}`);
  if (wireless) notes.push('A wireless gateway is set up and enabled.');
  if (family === 'irc5' && !hasPcInterface(options)) {
    notes.push('PC Interface (616-1) is not installed: an IRC5 answers Robot Web Services on its WAN port only with it.');
    return { serviceOnly: true, verdict: `Service port only (${SERVICE_PORT_IP}): PC Interface (616-1) is not installed.`, notes };
  }
  if (family === 'irc5') notes.push('PC Interface (616-1) is installed.');
  if (best) return { serviceOnly: false, ip: best.address, via: best.port ?? best.name, verdict: `Reachable without the service port at ${best.address} (${best.port ?? best.name}).`, notes };
  if (dhcp) return { serviceOnly: false, via: 'DHCP', verdict: 'Reachable without the service port, at an address the network hands out (DHCP): look it up on the FlexPendant or the DHCP server.', notes };
  if (wireless) return { serviceOnly: false, via: 'wireless', verdict: 'Reachable over the wireless gateway; no fixed address is configured for it here.', notes };
  return { serviceOnly: true, verdict: `Service port only (${SERVICE_PORT_IP}): no address is configured on another port.`, notes };
}
