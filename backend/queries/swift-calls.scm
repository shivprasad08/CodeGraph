;; CodeGraph addition: call references (the official Swift tags query has none)
(call_expression (simple_identifier) @name) @reference.call
(call_expression (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @name))) @reference.call
