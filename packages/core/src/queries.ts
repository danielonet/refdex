import type { LanguageId } from './languages.ts';

/**
 * Definition queries. Each pattern captures the definition node as `@<kind>` (a normalized
 * symbol kind) and its identifier as `@name`; `@import` captures an import statement.
 * Spike-level: Phase 1 replaces these with full LanguageAdapters.
 */
const python = `
(class_definition name: (identifier) @name) @class
(function_definition name: (identifier) @name) @function
(import_statement) @import
(import_from_statement) @import
(future_import_statement) @import
`;

const typescript = `
(class_declaration name: (type_identifier) @name) @class
(abstract_class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(type_alias_declaration name: (type_identifier) @name) @type_alias
(function_declaration name: (identifier) @name) @function
(method_definition name: (property_identifier) @name) @method
(method_signature name: (property_identifier) @name) @method
(abstract_method_signature name: (property_identifier) @name) @method
(public_field_definition name: (property_identifier) @name) @property
(property_signature name: (property_identifier) @name) @property
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @function
(import_statement) @import
(export_statement source: (string)) @import
`;

const java = `
(package_declaration (_) @name) @namespace
(class_declaration name: (identifier) @name) @class
(record_declaration name: (identifier) @name) @class
(interface_declaration name: (identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name) @method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @field
(import_declaration) @import
`;

const csharp = `
(namespace_declaration name: (_) @name) @namespace
(file_scoped_namespace_declaration name: (_) @name) @namespace
(class_declaration name: (identifier) @name) @class
(struct_declaration name: (identifier) @name) @class
(record_declaration name: (identifier) @name) @class
(interface_declaration name: (identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name) @method
(property_declaration name: (identifier) @name) @property
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @field
(using_directive) @import
`;

export const DEFINITION_QUERIES: Record<LanguageId, string> = {
  python,
  typescript,
  tsx: typescript,
  java,
  csharp,
};
