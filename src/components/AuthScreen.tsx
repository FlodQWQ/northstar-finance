import {
  AlertCircle,
  CheckCircle2,
  Compass,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ApiError,
  type LoginInput,
  type RegistrationSubmission,
  type RegisterInput,
} from "../api";

export type AuthMode = "login" | "register";

type AuthValues = {
  identifier: string;
  username: string;
  email: string;
  password: string;
};

type AuthField = keyof AuthValues;
type FieldErrors = Partial<Record<AuthField, string>>;

const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(values: AuthValues, mode: AuthMode): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === "login") {
    if (!values.identifier.trim()) errors.identifier = "请输入用户名或邮箱";
    if (!values.password) errors.password = "请输入密码";
    return errors;
  }

  const username = values.username.trim().normalize("NFKC");
  const email = values.email.trim().normalize("NFKC");
  if (!username) {
    errors.username = "请输入用户名";
  } else if (!usernamePattern.test(username)) {
    errors.username = "需为 3–32 位，首位为字母或数字，可使用 . _ -";
  }
  if (
    email &&
    (email.length > 254 ||
      !emailPattern.test(email) ||
      email.startsWith(".") ||
      email.endsWith(".") ||
      email.includes(".."))
  ) {
    errors.email = "请输入有效的邮箱地址";
  }
  const passwordCharacters = Array.from(values.password).length;
  const passwordBytes = new TextEncoder().encode(values.password).length;
  if (!values.password) {
    errors.password = "请输入密码";
  } else if (
    passwordCharacters < 12 ||
    passwordCharacters > 128 ||
    passwordBytes > 512 ||
    !/\S/u.test(values.password)
  ) {
    errors.password = "密码需为 12–128 个字符，且不能全为空格";
  }
  return errors;
}

function apiErrorDetails(error: unknown, mode: AuthMode): {
  general?: string;
  fields?: FieldErrors;
} {
  if (!(error instanceof ApiError)) return { general: "请求未完成，请稍后重试" };
  switch (error.code) {
    case "INVALID_CREDENTIALS":
      return { general: "用户名或密码不正确" };
    case "ACCOUNT_PENDING":
      return { general: "注册申请正在等待管理员审批，批准后即可登录" };
    case "ACCOUNT_DISABLED":
      return { general: "该账户已停用，请联系管理员" };
    case "INVALID_USERNAME":
      return { fields: { username: "用户名格式不符合要求" } };
    case "USERNAME_TAKEN":
      return { fields: { username: "该用户名已被使用" } };
    case "INVALID_EMAIL":
      return { fields: { email: "请输入有效的邮箱地址" } };
    case "EMAIL_TAKEN":
      return { fields: { email: "该邮箱已被使用" } };
    case "INVALID_PASSWORD":
      return { fields: { password: "密码需为 12–128 个字符，且不能全为空格" } };
    default:
      if (error.status === 0) return { general: "无法连接服务，请检查网络后重试" };
      if (error.status >= 500) return { general: "认证服务暂时不可用，请稍后重试" };
      return {
        general: mode === "login" ? "登录失败，请检查输入后重试" : "注册失败，请检查输入后重试",
      };
  }
}

function Brand() {
  return (
    <div className="auth-brand" aria-label="Northstar Finance">
      <span className="brand-mark"><Compass size={20} /></span>
      <span><strong>Northstar</strong><small>个人资产工作台</small></span>
    </div>
  );
}

export function AuthLoadingScreen() {
  return (
    <main className="auth-screen">
      <section className="auth-panel auth-status-panel" role="status" aria-live="polite">
        <Brand />
        <div className="auth-status-copy">
          <LoaderCircle className="spin" size={22} />
          <strong>正在确认登录状态</strong>
        </div>
      </section>
    </main>
  );
}

export function AuthUnavailableScreen({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-panel auth-status-panel" role="alert">
        <Brand />
        <div className="auth-status-copy auth-status-error">
          <AlertCircle size={23} />
          <strong>暂时无法打开登录</strong>
          <p>{message}</p>
          <button className="button secondary auth-retry-button" type="button" onClick={onRetry} disabled={retrying}>
            {retrying ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
            {retrying ? "正在重试" : "重新连接"}
          </button>
        </div>
      </section>
    </main>
  );
}

export default function AuthScreen({
  onSubmit,
}: {
  onSubmit: (mode: AuthMode, input: LoginInput | RegisterInput) => Promise<RegistrationSubmission | void>;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [values, setValues] = useState<AuthValues>({
    identifier: "",
    username: "",
    email: "",
    password: "",
  });
  const [touched, setTouched] = useState<Partial<Record<AuthField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const clientErrors = useMemo(() => validate(values, mode), [mode, values]);

  const errorFor = (field: AuthField) => {
    if (serverErrors[field]) return serverErrors[field];
    return submitted || touched[field] ? clientErrors[field] : undefined;
  };

  const updateValue = (field: AuthField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => ({ ...current, [field]: undefined }));
    setGeneralError("");
  };

  const switchMode = (nextMode: AuthMode) => {
    if (nextMode === mode || submitting) return;
    setMode(nextMode);
    setTouched({});
    setSubmitted(false);
    setServerErrors({});
    setGeneralError("");
    setSuccessMessage("");
    setShowPassword(false);
  };

  const focusFirstError = (errors: FieldErrors) => {
    const order: AuthField[] = mode === "login"
      ? ["identifier", "password"]
      : ["username", "email", "password"];
    const refs: Record<AuthField, React.RefObject<HTMLInputElement | null>> = {
      identifier: identifierRef,
      username: usernameRef,
      email: emailRef,
      password: passwordRef,
    };
    const first = order.find((field) => errors[field]);
    if (first) refs[first].current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setGeneralError("");
    setSuccessMessage("");
    setServerErrors({});
    if (Object.keys(clientErrors).length > 0) {
      focusFirstError(clientErrors);
      return;
    }

    const input: LoginInput | RegisterInput = mode === "login"
      ? { identifier: values.identifier.trim(), password: values.password }
      : {
          username: values.username.trim().normalize("NFKC"),
          ...(values.email.trim()
            ? { email: values.email.trim().normalize("NFKC") }
            : {}),
          password: values.password,
        };

    setSubmitting(true);
    try {
      const result = await onSubmit(mode, input);
      if (mode === "register" && result?.approvalRequired) {
        setValues({
          identifier: result.user.username,
          username: "",
          email: "",
          password: "",
        });
        setMode("login");
        setTouched({});
        setSubmitted(false);
        setShowPassword(false);
        setSuccessMessage("申请已提交，等待管理员审批");
        window.requestAnimationFrame(() => identifierRef.current?.focus());
      }
    } catch (error) {
      const details = apiErrorDetails(error, mode);
      if (details.fields) {
        setServerErrors(details.fields);
        window.requestAnimationFrame(() => focusFirstError(details.fields ?? {}));
      }
      setGeneralError(details.general ?? "");
    } finally {
      setSubmitting(false);
    }
  };

  const passwordError = errorFor("password");

  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-title">
        <Brand />
        <header className="auth-heading">
          <h1 id="auth-title">{mode === "login" ? "登录账户" : "创建账户"}</h1>
          <p>{mode === "login" ? "继续进入你的个人资产工作台" : "提交申请后，由管理员审核账户"}</p>
        </header>

        <div className="auth-segments" role="tablist" aria-label="认证方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => switchMode("login")}
            disabled={submitting}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => switchMode("register")}
            disabled={submitting}
          >
            注册
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {successMessage ? (
            <div className="auth-form-success" role="status" aria-live="polite">
              <CheckCircle2 size={16} />
              <span>{successMessage}</span>
            </div>
          ) : null}

          {mode === "login" ? (
            <label className="auth-field" htmlFor="auth-identifier">
              <span>用户名或邮箱</span>
              <input
                ref={identifierRef}
                id="auth-identifier"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={values.identifier}
                onChange={(event) => updateValue("identifier", event.target.value)}
                onBlur={() => setTouched((current) => ({ ...current, identifier: true }))}
                aria-invalid={Boolean(errorFor("identifier"))}
                aria-describedby={errorFor("identifier") ? "auth-identifier-error" : undefined}
                disabled={submitting}
                autoFocus
              />
              {errorFor("identifier") ? <small id="auth-identifier-error" role="alert">{errorFor("identifier")}</small> : null}
            </label>
          ) : (
            <>
              <label className="auth-field" htmlFor="auth-username">
                <span>用户名</span>
                <input
                  ref={usernameRef}
                  id="auth-username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={32}
                  value={values.username}
                  onChange={(event) => updateValue("username", event.target.value)}
                  onBlur={() => setTouched((current) => ({ ...current, username: true }))}
                  aria-invalid={Boolean(errorFor("username"))}
                  aria-describedby={errorFor("username") ? "auth-username-error" : "auth-username-hint"}
                  disabled={submitting}
                  autoFocus
                />
                {errorFor("username") ? (
                  <small id="auth-username-error" role="alert">{errorFor("username")}</small>
                ) : (
                  <small id="auth-username-hint">3–32 位，可使用字母、数字、点、下划线和连字符</small>
                )}
              </label>

              <label className="auth-field" htmlFor="auth-email">
                <span>邮箱 <em>可选</em></span>
                <input
                  ref={emailRef}
                  id="auth-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  value={values.email}
                  onChange={(event) => updateValue("email", event.target.value)}
                  onBlur={() => setTouched((current) => ({ ...current, email: true }))}
                  aria-invalid={Boolean(errorFor("email"))}
                  aria-describedby={errorFor("email") ? "auth-email-error" : undefined}
                  disabled={submitting}
                />
                {errorFor("email") ? <small id="auth-email-error" role="alert">{errorFor("email")}</small> : null}
              </label>
            </>
          )}

          <label className="auth-field" htmlFor="auth-password">
            <span>密码</span>
            <span className={`auth-password-control${passwordError ? " error" : ""}`}>
              <input
                ref={passwordRef}
                id="auth-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={values.password}
                onChange={(event) => updateValue("password", event.target.value)}
                onBlur={() => setTouched((current) => ({ ...current, password: true }))}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? "auth-password-error" : mode === "register" ? "auth-password-hint" : undefined}
                disabled={submitting}
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
                title={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((current) => !current)}
                disabled={submitting}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
            {passwordError ? (
              <small id="auth-password-error" role="alert">{passwordError}</small>
            ) : mode === "register" ? (
              <small id="auth-password-hint">至少 12 个字符</small>
            ) : null}
          </label>

          {generalError ? (
            <div className="auth-form-error" role="alert">
              <AlertCircle size={16} />
              <span>{generalError}</span>
            </div>
          ) : null}

          <button className="button primary auth-submit" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={18} /> : null}
            {submitting ? (mode === "login" ? "正在登录" : "正在提交") : (mode === "login" ? "登录" : "提交注册申请")}
          </button>
        </form>
      </section>
    </main>
  );
}
