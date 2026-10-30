// Script "prepare" do pnpm install: instala os hooks do Git (lefthook.yml).
// Sem .git (zip do repositório, imagem Docker da Fase 7, upload do EAS Build) não há onde
// instalar hooks, e o "lefthook install" derrubaria o pnpm install: nesse caso, só avisa.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  execSync('lefthook install', { stdio: 'inherit' });
} else {
  console.warn('prepare: sem .git, os hooks do lefthook não foram instalados.');
}
