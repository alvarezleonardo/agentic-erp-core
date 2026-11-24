import { readFileSync } from 'node:fs';

/** Componentes que todo agente puede usar además de los suyos: preguntar y avisar. */
export const COMUNES = ['Clarification', 'ErrorNotice', 'StatusToast'];

/** Lee el playbook.md que está junto al agente. Su contenido es exactamente el prompt (sin el salto de línea final). */
export const leerPlaybook = (urlDelAgente: string): string => readFileSync(new URL('./playbook.md', urlDelAgente), 'utf8').replace(/\r?\n$/, '');
