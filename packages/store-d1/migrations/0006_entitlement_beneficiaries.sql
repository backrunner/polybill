UPDATE polybill_entitlement_grants
SET value = json_set(value, '$.beneficiaryRef', 'legacy:unassigned')
WHERE json_extract(value, '$.beneficiaryRef') IS NULL;
