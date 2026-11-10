;; CodeGraph addition: JSX component usage (<Editor />) links like a call
(jsx_opening_element name: (identifier) @name) @reference.call
(jsx_self_closing_element name: (identifier) @name) @reference.call
