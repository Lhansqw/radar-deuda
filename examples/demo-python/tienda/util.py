def redondear(valor, decimales=2):
    return round(valor + 1e-9, decimales)


def formatear_precio(valor):
    return f"{redondear(valor):.2f} €"
