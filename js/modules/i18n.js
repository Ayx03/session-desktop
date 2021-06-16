/* eslint-env node */
/* global log */

exports.setup = (locale, messages) => {
  if (!locale) {
    throw new Error('i18n: locale parameter is required');
  }
  if (!messages) {
    throw new Error('i18n: messages parameter is required');
  }

  function getMessage(key, substitutions) {
    const message = messages[key];
    if (!message) {
      log.error(`i18n: Attempted to get translation for nonexistent key '${key}'`);
      return '';
    }

    if (Array.isArray(substitutions)) {
      return substitutions.reduce(
        (result, substitution) => result.replace(/\$.+?\$/, substitution),
        message
      );
    } else if (substitutions) {
      return message.replace(/\$.+?\$/, substitutions);
    }

    return message;
  }

  getMessage.getLocale = () => locale;

  return getMessage;
};
