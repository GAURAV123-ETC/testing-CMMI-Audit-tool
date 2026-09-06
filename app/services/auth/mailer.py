import smtplib
from email.message import EmailMessage
from app.core.config import get_settings

def send_reset_email(recipient: str, token: str) -> bool:
    settings = get_settings()
    sender = settings.smtp_from_email or settings.sender_email
    if not all((settings.smtp_host, settings.smtp_username, settings.smtp_password, sender)):
        return False
    message = EmailMessage(); message['Subject']='Reset your CMMI Audit Platform password'; message['From']=sender; message['To']=recipient
    message.set_content(f'Use this one-time password reset link within one hour: {settings.public_base_url.rstrip("/")}/login?reset_token={token}')
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as client:
        client.starttls(); client.login(settings.smtp_username, settings.smtp_password); client.send_message(message)
    return True
