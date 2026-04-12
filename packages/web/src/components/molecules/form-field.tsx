import { Label } from '@/components/atoms/label';
import { Input } from '@/components/atoms/input';
import type { ComponentProps } from 'react';

type InputProps = ComponentProps<typeof Input>;

type FormFieldProps = {
  label: string;
  labelRightSlot?: React.ReactNode;
  inputProps: InputProps;
};

export function FormField({ label, labelRightSlot, inputProps }: FormFieldProps) {
  return (
    <div className="space-y-2">
      <Label rightSlot={labelRightSlot}>{label}</Label>
      <Input {...inputProps} />
    </div>
  );
}
