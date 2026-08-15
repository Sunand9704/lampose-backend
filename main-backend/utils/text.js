/* Search terms arrive straight from a text input and end up inside a RegExp.
   An unescaped "(" or "*" is a syntax error, so a visitor typing a bracket
   would get a 500 from what is meant to be a search box. */
const escapeRegex = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRegex };
