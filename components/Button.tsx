import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'text';
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  fullWidth = false,
  className = '',
  ...props
}) => {
  const baseStyles = "py-3.5 px-6 rounded-xl font-semibold transition-all duration-200 text-center flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variants = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 focus:ring-blue-500 shadow-sm",
    outline: "bg-transparent border-2 border-blue-600 text-blue-700 hover:bg-blue-50 active:bg-blue-100 focus:ring-blue-500",
    text: "bg-transparent text-blue-700 hover:text-blue-800 active:text-blue-900 underline-offset-4 hover:underline focus:ring-blue-500 p-0 shadow-none"
  };

  const widthClass = fullWidth ? "w-full" : "w-auto";

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${widthClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};