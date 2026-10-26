import smtplib
import ssl
from email.message import EmailMessage
from app.core.config import get_settings

def send_reset_email(recipient: str, token: str) -> bool:
    settings = get_settings()
    sender = settings.smtp_from_email or settings.sender_email
    if not all((settings.smtp_host, settings.smtp_username, settings.smtp_password, sender)):
        return False
    message = EmailMessage(); message['Subject']='Reset your CMMI Audit Platform password'; message['From']=sender; message['To']=recipient
    message.set_content(f'Use this one-time password reset link within one hour: {settings.public_base_url.rstrip("/")}/login?reset_token={token}')
    context = ssl.create_default_context()
    if settings.smtp_tls_mode == 'implicit':
        client_context = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15, context=context)
    elif settings.smtp_tls_mode == 'starttls':
        client_context = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
    else:
        raise ValueError('Unsupported SMTP TLS mode')
    with client_context as client:
        if settings.smtp_tls_mode == 'starttls':
            client.starttls(context=context)
        client.login(settings.smtp_username, settings.smtp_password)
        client.send_message(message)
    return True
