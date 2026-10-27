import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { codeProblem, emailProblem, newPasswordProblem, type AccountState } from '../../shared/account.js';
import { AccessFrame } from '../components/AccessFrame.js';
import { PasswordField } from '../components/PasswordField.js';

/** Pasos del acceso. El correo se conserva al pasar de uno a otro. */
type Step = { kind: 'signIn' } | { kind: 'signUp' } | { kind: 'confirm'; sent: boolean } | { kind: 'forgot' } | { kind: 'reset' };

/** Espera antes de poder pedir otro código (Supabase limita los correos por hora). */
const RESEND_WAIT_S = 60;

interface Ctx {
  email: string;
  setEmail: (v: string) => void;
  go: (step: Step) => void;
  /** Ejecuta una acción mostrando su error (si lo hay) en el formulario. */
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
  error: string | null;
}

/**
 * Inicio de sesión, registro, confirmación del correo y recuperación de la
 * contraseña. Cuando la sesión se inicia, el proceso principal avisa y la
 * aplicación aparece sola (Root.tsx).
 */
export function Access({ state }: { state: Extract<AccountState, { status: 'signed-out' | 'password-reset' }> }) {
  const [step, setStep] = useState<Step>({ kind: 'signIn' });
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = useCallback((next: Step) => {
    setError(null);
    setStep(next);
  }, []);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);
  const ctx: Ctx = { email, setEmail, go, run, busy, error };

  let form: ReactNode;
  if (state.status === 'password-reset') form = <NewPasswordForm ctx={ctx} email={state.email} />;
  else if (step.kind === 'signUp') form = <SignUpForm ctx={ctx} />;
  else if (step.kind === 'confirm') form = <ConfirmForm ctx={ctx} sent={step.sent} />;
  else if (step.kind === 'forgot') form = <ForgotForm ctx={ctx} />;
  else if (step.kind === 'reset') form = <ResetForm ctx={ctx} />;
  else form = <SignInForm ctx={ctx} />;

  return <AccessFrame>{form}</AccessFrame>;
}

/** Formulario de acceso: campos, el error (junto al botón) y enlaces a otros pasos. */
function Form({ ctx, title, intro, submit, onSubmit, links, children }: { ctx: Ctx; title: string; intro?: ReactNode; submit: string; onSubmit: () => void; links: ReactNode; children: ReactNode }) {
  return (
    <form
      className="access-form"
      aria-labelledby="titulo-acceso"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 id="titulo-acceso">{title}</h2>
      {intro ? <p className="access-intro">{intro}</p> : null}
      {children}
      {ctx.error ? (
        <p className="form-error" role="alert">
          {ctx.error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={ctx.busy}>
        {submit}
      </button>
      <div className="access-links">{links}</div>
    </form>
  );
}

function EmailField({ ctx, autoFocus = true }: { ctx: Ctx; autoFocus?: boolean }) {
  return (
    <div className="field">
      <label htmlFor="correo">Correo</label>
      <input id="correo" className="input" type="email" value={ctx.email} onChange={(e) => ctx.setEmail(e.target.value)} autoComplete="email" spellCheck={false} autoFocus={autoFocus} required />
    </div>
  );
}

/** Comprueba en el formulario antes de enviar; el servidor tiene la última palabra. */
function firstProblem(...problems: Array<string | null>): string | null {
  return problems.find((p) => p !== null) ?? null;
}

function SignInForm({ ctx }: { ctx: Ctx }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(emailProblem(ctx.email), password === '' ? 'Escribe tu contraseña.' : null);
      if (problem) throw new Error(problem);
      const r = await window.radar.account.signIn(ctx.email, password, remember);
      if (r.confirmEmail) ctx.go({ kind: 'confirm', sent: false });
    });
  return (
    <Form
      ctx={ctx}
      title="Inicia sesión"
      submit="Iniciar sesión"
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" onClick={() => ctx.go({ kind: 'forgot' })}>
            ¿Olvidaste tu contraseña?
          </button>
          <span>
            ¿No tienes cuenta?{' '}
            <button type="button" className="link" onClick={() => ctx.go({ kind: 'signUp' })}>
              Crear una
            </button>
          </span>
        </>
      }
    >
      <EmailField ctx={ctx} />
      <PasswordField label="Contraseña" value={password} onChange={setPassword} autoComplete="current-password" />
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Seguir conectado en este equipo</span>
      </label>
    </Form>
  );
}

function SignUpForm({ ctx }: { ctx: Ctx }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(emailProblem(ctx.email), newPasswordProblem(password), password !== repeat ? 'Las dos contraseñas no coinciden.' : null);
      if (problem) throw new Error(problem);
      const r = await window.radar.account.signUp(ctx.email, password);
      if (r.confirmEmail) ctx.go({ kind: 'confirm', sent: true });
    });
  return (
    <Form
      ctx={ctx}
      title="Crea tu cuenta"
      intro="Con tu cuenta, tus proyectos, tu historial y tus claves de IA quedan separados de los de otras personas que usen este equipo."
      submit="Crear cuenta"
      onSubmit={submit}
      links={
        <span>
          ¿Ya tienes cuenta?{' '}
          <button type="button" className="link" onClick={() => ctx.go({ kind: 'signIn' })}>
            Inicia sesión
          </button>
        </span>
      }
    >
      <EmailField ctx={ctx} />
      <PasswordField label="Contraseña" value={password} onChange={setPassword} autoComplete="new-password" hint="Al menos 8 caracteres." />
      <PasswordField label="Repite la contraseña" value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

function ConfirmForm({ ctx, sent }: { ctx: Ctx; sent: boolean }) {
  const [code, setCode] = useState('');
  const resend = useResend(sent);
  const submit = () =>
    void ctx.run(async () => {
      const problem = codeProblem(code);
      if (problem) throw new Error(problem);
      await window.radar.account.confirmEmail(ctx.email, code);
    });
  return (
    <Form
      ctx={ctx}
      title="Confirma tu correo"
      intro={
        sent ? (
          <>
            Te enviamos un código a <strong>{ctx.email.trim()}</strong>. Si no llega en unos minutos, revisa el correo no deseado. Si ya tenías una cuenta con ese correo, inicia sesión.
          </>
        ) : (
          <>
            La cuenta <strong>{ctx.email.trim()}</strong> aún no confirmó su correo. Pide el código y escríbelo aquí.
          </>
        )
      }
      submit="Confirmar"
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" disabled={ctx.busy || resend.wait > 0} onClick={() => void ctx.run(async () => resend.send(() => window.radar.account.resendConfirmation(ctx.email)))}>
            {resend.label(sent ? 'Reenviar el código' : 'Enviar el código')}
          </button>
          <button type="button" className="link" onClick={() => ctx.go({ kind: 'signIn' })}>
            Volver a iniciar sesión
          </button>
        </>
      }
    >
      <CodeField value={code} onChange={setCode} />
    </Form>
  );
}

function ForgotForm({ ctx }: { ctx: Ctx }) {
  const submit = () =>
    void ctx.run(async () => {
      const problem = emailProblem(ctx.email);
      if (problem) throw new Error(problem);
      await window.radar.account.requestPasswordReset(ctx.email);
      ctx.go({ kind: 'reset' });
    });
  return (
    <Form
      ctx={ctx}
      title="Recupera tu contraseña"
      intro="Escribe el correo de tu cuenta. Te enviaremos un código para elegir una contraseña nueva."
      submit="Enviar el código"
      onSubmit={submit}
      links={<BackToSignIn ctx={ctx} />}
    >
      <EmailField ctx={ctx} />
    </Form>
  );
}

function ResetForm({ ctx }: { ctx: Ctx }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const resend = useResend(true);
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(codeProblem(code), newPasswordProblem(password), password !== repeat ? 'Las dos contraseñas no coinciden.' : null);
      if (problem) throw new Error(problem);
      await window.radar.account.resetPassword(ctx.email, code, password);
    });
  return (
    <Form
      ctx={ctx}
      title="Elige una contraseña nueva"
      intro={
        <>
          Si <strong>{ctx.email.trim()}</strong> tiene una cuenta, le llegará un código. Escríbelo con tu contraseña nueva.
        </>
      }
      submit="Guardar la contraseña"
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" disabled={ctx.busy || resend.wait > 0} onClick={() => void ctx.run(async () => resend.send(() => window.radar.account.requestPasswordReset(ctx.email)))}>
            {resend.label('Reenviar el código')}
          </button>
          <BackToSignIn ctx={ctx} />
        </>
      }
    >
      <CodeField value={code} onChange={setCode} />
      <PasswordField label="Contraseña nueva" value={password} onChange={setPassword} autoComplete="new-password" hint="Al menos 8 caracteres." />
      <PasswordField label="Repite la contraseña" value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

/** El código ya se comprobó, pero Supabase rechazó la contraseña: se elige otra. */
function NewPasswordForm({ ctx, email }: { ctx: Ctx; email: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(newPasswordProblem(password), password !== repeat ? 'Las dos contraseñas no coinciden.' : null);
      if (problem) throw new Error(problem);
      await window.radar.account.setNewPassword(password);
    });
  return (
    <Form
      ctx={ctx}
      title="Elige una contraseña nueva"
      intro={
        <>
          El código de <strong>{email}</strong> es válido. Elige la contraseña con la que entrarás a partir de ahora.
        </>
      }
      submit="Guardar la contraseña"
      onSubmit={submit}
      links={
        <button type="button" className="link" onClick={() => void ctx.run(async () => void (await window.radar.account.signOut()))}>
          Cancelar
        </button>
      }
    >
      <PasswordField label="Contraseña nueva" value={password} onChange={setPassword} autoComplete="new-password" hint="Al menos 8 caracteres." autoFocus />
      <PasswordField label="Repite la contraseña" value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

function BackToSignIn({ ctx }: { ctx: Ctx }) {
  return (
    <button type="button" className="link" onClick={() => ctx.go({ kind: 'signIn' })}>
      Volver a iniciar sesión
    </button>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="codigo">Código del correo</label>
      <input
        id="codigo"
        className="input mono code-input"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        autoFocus
        required
      />
    </div>
  );
}

/** Botón de reenviar con espera: Supabase limita los correos (2 por hora con su servidor de serie). */
function useResend(justSent: boolean) {
  const [wait, setWait] = useState(justSent ? RESEND_WAIT_S : 0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return {
    wait,
    label: (text: string) => (wait > 0 ? `${text} (en ${wait} s)` : text),
    send: async (fn: () => Promise<null>) => {
      await fn();
      setWait(RESEND_WAIT_S);
    },
  };
}
