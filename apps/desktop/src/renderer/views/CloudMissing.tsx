import { AccessFrame } from '../components/AccessFrame.js';

/** La aplicación se compiló o se abrió sin la conexión con Supabase: no se puede iniciar sesión. */
export function CloudMissing({ message }: { message: string }) {
  return (
    <AccessFrame>
      <div className="access-form">
        <h2>Falta la conexión con Supabase</h2>
        <p className="access-intro">Para entrar hace falta una cuenta, y las cuentas viven en el proyecto de Supabase de la aplicación. Esta copia no sabe cuál es.</p>
        <p className="access-detail" role="alert">
          {message}
        </p>
        <p className="access-intro">Si instalaste la aplicación, pide una versión compilada con la conexión.</p>
      </div>
    </AccessFrame>
  );
}
