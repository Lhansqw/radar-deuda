# TODO: mover a una plantilla.


def generar_factura(cliente, pedidos):
    lineas = []
    importe = 0
    for pedido in pedidos:
        for item in pedido["items"]:
            subtotal = item["precio"] * item["cantidad"]
            if item.get("descuento"):
                subtotal -= subtotal * item["descuento"]
            importe += subtotal
            lineas.append(f'{item["nombre"]}: {subtotal:.2f}')
    lineas.append(f"Total: {importe:.2f}")
    return f'Factura para {cliente["nombre"]}\n' + "\n".join(lineas)
