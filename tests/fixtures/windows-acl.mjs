import { spawnSync } from 'node:child_process';
// Compare the binary DACL (including ACE order/masks/flags) and all control
// flags. Windows may set AUTO_INHERITED while restoring inherited entries;
// clearing it or changing any other flag is not an allowed normalization.
export function sameAclPermissions(before, after) {
  return before.dacl === after.dacl && (after.control === before.control || (!(before.control & 0x400) && after.control === (before.control | 0x400)));
}
export function describeWindowsAcl({ file, sddl }) {
  const script = `if($env:MAWF_ACL_FILE){$bytes=[IO.Directory]::GetAccessControl($env:MAWF_ACL_FILE).GetSecurityDescriptorBinaryForm();$sd=[Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)}else{$sd=[Security.AccessControl.RawSecurityDescriptor]::new($env:MAWF_ACL_SDDL)}; $value='NULL';if($null -ne $sd.DiscretionaryAcl){$bytes=New-Object byte[] $sd.DiscretionaryAcl.BinaryLength;$sd.DiscretionaryAcl.GetBinaryForm($bytes,0);$value=[Convert]::ToBase64String($bytes)};[Console]::WriteLine(('{0}|{1}' -f [int]$sd.ControlFlags,$value))`;
  const env = { ...process.env, MAWF_ACL_FILE: file || '', MAWF_ACL_SDDL: sddl || '' };
  delete env.PSModulePath;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env });
  if (result.status !== 0) throw new Error(result.stderr);
  const [control, dacl] = result.stdout.trim().split('|');
  return { control: Number(control), dacl: dacl === 'NULL' ? null : dacl };
}
