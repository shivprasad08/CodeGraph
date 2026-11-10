;; CodeGraph addition: call references (the official C tags query has none)
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
