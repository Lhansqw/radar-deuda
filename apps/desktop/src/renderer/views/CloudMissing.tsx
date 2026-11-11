import { AccessFrame } from '../components/AccessFrame.js';
import { tr } from '../i18n.js';

/** La aplicación se compiló o se abrió sin la conexión con Supabase: no se puede iniciar sesión. */
export function CloudMissing({ message }: { message: string }) {
  return (
    <AccessFrame>
      <div className="access-form">
        <h2>{tr('Falta la conexión con Supabase', 'The Supabase connection is missing')}</h2>
        <p className="access-intro">
          {tr(
            'Para entrar hace falta una cuenta, y las cuentas viven en el proyecto de Supabase de la aplicación. Esta copia no sabe cuál es.',
            "Signing in needs an account, and accounts live in the app's Supabase project. This copy does not know which one it is.",
          )}
        </p>
        <p className="access-detail" role="alert">
          {message}
        </p>
        <p className="access-intro">{tr('Si instalaste la aplicación, pide una versión compilada con la conexión.', 'If you installed the app, ask for a version built with the connection.')}</p>
      </div>
    </AccessFrame>
  );
}
