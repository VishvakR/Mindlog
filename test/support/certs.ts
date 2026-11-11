import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const openssl = (dir: string, ...args: string[]) => {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
};

export interface CertSet {
  readonly dir: string;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  /** Issues a fresh leaf from this CA in place, as a rotation would. */
  rotate(): void;
  remove(): void;
}

/** A throwaway CA and one leaf for 127.0.0.1, made at run time so no key is ever committed. */
export function makeCerts(name = 'node'): CertSet {
  const dir = mkdtempSync(join(tmpdir(), 'mindlog-certs-'));
  openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  openssl(
    dir,
    'req',
    '-x509',
    '-new',
    '-key',
    'ca.key',
    '-subj',
    `/CN=${name}-ca`,
    '-days',
    '2',
    '-out',
    'ca.pem',
  );
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
  let serial = 1;
  const issue = () => {
    openssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'next.key');
    openssl(dir, 'req', '-new', '-key', 'next.key', '-subj', `/CN=${name}`, '-out', 'node.csr');
    openssl(
      dir,
      'x509',
      '-req',
      '-in',
      'node.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      String(++serial),
      '-days',
      '2',
      '-extfile',
      'ext.cnf',
      '-out',
      'next.pem',
    );
    execFileSync('mv', ['next.key', 'node.key'], { cwd: dir });
    execFileSync('mv', ['next.pem', 'node.pem'], { cwd: dir });
  };
  issue();
  return {
    dir,
    ca: join(dir, 'ca.pem'),
    cert: join(dir, 'node.pem'),
    key: join(dir, 'node.key'),
    rotate: issue,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
