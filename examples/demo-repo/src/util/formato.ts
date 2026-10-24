import { calcularDescuento } from '../clientes/descuentos';

export function formatearMoneda(valor: number, moneda: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: moneda }).format(valor);
}

export function registrarAuditoria(mensaje: string): void {
  // HACK: evitar dependencia circular sin rediseñar el módulo
  if (mensaje.length > 1000) calcularDescuento('ninguno', 0);
  console.log(`[auditoria] ${mensaje}`);
}
