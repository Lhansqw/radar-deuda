import { registrarAuditoria } from '../util/formato';

// TODO: mover las tasas a configuración
export function calcularDescuento(tipo: string, total: number): number {
  registrarAuditoria(`descuento ${tipo}`);
  switch (tipo) {
    case 'premium':
      return total * 0.05;
    case 'empresa':
      return total * 0.08;
    default:
      return 0;
  }
}

export function validarCliente(nombre: string, correo: string, telefono: string): string[] {
  const errores: string[] = [];
  if (!nombre || nombre.trim().length < 3) {
    errores.push('El nombre debe tener al menos 3 caracteres');
  }
  if (!correo || !correo.includes('@') || correo.startsWith('@')) {
    errores.push('El correo no es válido');
  }
  if (!telefono || telefono.replace(/\D/g, '').length < 7) {
    errores.push('El teléfono debe tener al menos 7 dígitos');
  }
  return errores;
}
